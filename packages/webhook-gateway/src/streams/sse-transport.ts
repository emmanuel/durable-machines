import type { Logger, StreamCursor, StreamMessage, StreamTransport } from "./types.js";

/** Internal cursor shape for SSE transport. */
interface SseCursor extends Record<string, unknown> {
  lastEventId?: string;
  since?: string;
}

export interface SseTransportOptions {
  url: string;
  auth?: { basic?: { username: string; password: string }; bearer?: string };
  headers?: Record<string, string>;
  /** Static query params (e.g., verb, activity filters). Appended to URL. */
  filter?: Record<string, string>;
  reconnect?: {
    initialBackoffMs?: number;
    maxBackoffMs?: number;
    maxRetries?: number;
  };
  logger: Logger;
}

export function sseTransport(options: SseTransportOptions): StreamTransport<string> {
  const {
    url: baseUrl,
    auth,
    headers: extraHeaders,
    filter,
    reconnect: reconnectOpts,
    logger,
  } = options;

  const initialBackoffMs = reconnectOpts?.initialBackoffMs ?? 1000;
  const maxBackoffMs = reconnectOpts?.maxBackoffMs ?? 30_000;
  const maxRetries = reconnectOpts?.maxRetries ?? Infinity;

  let retryMs = initialBackoffMs;

  function buildUrl(cursor: SseCursor | null): string {
    const u = new URL(baseUrl);
    if (filter) {
      for (const [k, v] of Object.entries(filter)) {
        u.searchParams.set(k, v);
      }
    }
    if (cursor?.since) {
      u.searchParams.set("since", cursor.since);
    }
    return u.toString();
  }

  function buildHeaders(cursor: SseCursor | null): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      ...extraHeaders,
    };
    if (auth?.basic) {
      const encoded = Buffer.from(
        `${auth.basic.username}:${auth.basic.password}`,
      ).toString("base64");
      h["Authorization"] = `Basic ${encoded}`;
    } else if (auth?.bearer) {
      h["Authorization"] = `Bearer ${auth.bearer}`;
    }
    if (cursor?.lastEventId) {
      h["Last-Event-ID"] = cursor.lastEventId;
    }
    return h;
  }

  async function* consume(
    cursor: StreamCursor | null,
    signal: AbortSignal,
  ): AsyncGenerator<StreamMessage<string>> {
    let sseCursor = (cursor as SseCursor | null) ?? null;
    let retries = 0;

    while (!signal.aborted) {
      try {
        const url = buildUrl(sseCursor);
        const headers = buildHeaders(sseCursor);

        logger.info({ url }, "SSE connecting");
        const res = await fetch(url, { headers, signal });

        if (!res.ok) {
          throw new Error(`SSE server returned ${res.status} ${res.statusText}`);
        }
        if (!res.body) {
          throw new Error("SSE response has no body");
        }

        // Reset retry counter and backoff on successful connection
        retries = 0;
        retryMs = initialBackoffMs;
        logger.info({ url }, "SSE connected");

        yield* parseSseStream(res.body, sseCursor, (c) => {
          sseCursor = c;
        });

        // Stream ended normally (server closed connection)
        if (signal.aborted) break;
        logger.warn({}, "SSE stream ended, reconnecting");
      } catch (err: unknown) {
        if (signal.aborted) break;
        retries++;
        if (retries > maxRetries) {
          logger.error(
            { retries, maxRetries },
            "SSE max retries exceeded, stopping",
          );
          break;
        }
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), retryMs },
          "SSE connection error, reconnecting",
        );
      }

      if (signal.aborted) break;

      // Exponential backoff wait
      await sleep(retryMs, signal);
      retryMs = Math.min(retryMs * 2, maxBackoffMs);
    }
  }

  return {
    consume,
    async acknowledge() {
      // No-op for SSE — cursor-based checkpointing, not per-message ack
    },
    async close() {
      // No-op — AbortSignal handles teardown
    },
  };
}

/** Parse an SSE byte stream into StreamMessage events. */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  initialCursor: SseCursor | null,
  onCursorUpdate: (cursor: SseCursor) => void,
): AsyncGenerator<StreamMessage<string>> {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let eventId: string | undefined = initialCursor?.lastEventId;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line === "") {
          // Empty line = event dispatch
          if (dataLines.length > 0) {
            const data = dataLines.join("\n");
            const cursor: SseCursor = {
              lastEventId: eventId,
              since: new Date().toISOString(),
            };
            onCursorUpdate(cursor);
            yield { raw: data, cursor };
          }
          // Reset for next event
          dataLines = [];
          continue;
        }

        if (line.startsWith(":")) {
          // Comment — skip
          continue;
        }

        const colonIdx = line.indexOf(":");
        let field: string;
        let value: string;
        if (colonIdx === -1) {
          field = line;
          value = "";
        } else {
          field = line.slice(0, colonIdx);
          // Strip single leading space after colon per SSE spec
          value =
            line[colonIdx + 1] === " "
              ? line.slice(colonIdx + 2)
              : line.slice(colonIdx + 1);
        }

        switch (field) {
          case "data":
            dataLines.push(value);
            break;
          case "id":
            // Per spec, id field must not contain null
            if (!value.includes("\0")) {
              eventId = value;
            }
            break;
          case "event":
            // Event type — currently unused but parsed per SSE spec
            break;
          case "retry": {
            const ms = parseInt(value, 10);
            if (!isNaN(ms) && ms >= 0) {
              // Update reconnection interval — captured via closure
              // Note: we don't directly expose retryMs here; the transport
              // manages its own backoff. The retry field is informational.
            }
            break;
          }
          // Unknown fields are ignored per SSE spec
        }
      }
    }

    // Flush any remaining buffered data
    if (buffer !== "") {
      // Process the remaining buffer as a final line
      // (incomplete line at stream end)
    }
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
