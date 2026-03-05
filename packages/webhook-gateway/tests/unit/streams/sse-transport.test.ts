import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sseTransport } from "../../../src/streams/sse-transport.js";
import type { Logger } from "../../../src/streams/types.js";

function createLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** No-reconnect config for simple parse tests. */
const noReconnect = { maxRetries: 0, initialBackoffMs: 1 } as const;

/** Helper: create a ReadableStream from SSE text. */
function sseStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Helper: create a ReadableStream that sends chunks with a delay. */
function chunkedSseStream(chunks: string[], delayMs = 5): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.close();
    },
  });
}

// Mock global fetch
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOk(body: ReadableStream<Uint8Array>) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: "OK",
    body,
  });
}

describe("sseTransport", () => {
  it("parses single-line SSE data events", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      reconnect: noReconnect,
      logger,
    });

    mockFetchOk(sseStream("data: hello world\n\n"));

    const controller = new AbortController();
    const messages = [];
    for await (const msg of transport.consume(null, controller.signal)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].raw).toBe("hello world");
  });

  it("parses multi-line data events (joined with newline)", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      reconnect: noReconnect,
      logger,
    });

    mockFetchOk(sseStream("data: line1\ndata: line2\ndata: line3\n\n"));

    const controller = new AbortController();
    const messages = [];
    for await (const msg of transport.consume(null, controller.signal)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].raw).toBe("line1\nline2\nline3");
  });

  it("extracts event ID from id: field", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      reconnect: noReconnect,
      logger,
    });

    mockFetchOk(sseStream("id: evt-42\ndata: payload\n\n"));

    const controller = new AbortController();
    const messages = [];
    for await (const msg of transport.consume(null, controller.signal)) {
      messages.push(msg);
    }

    expect(messages[0].cursor).toMatchObject({ lastEventId: "evt-42" });
  });

  it("skips comment lines (: prefix)", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      reconnect: noReconnect,
      logger,
    });

    mockFetchOk(sseStream(": this is a comment\ndata: actual data\n\n"));

    const controller = new AbortController();
    const messages = [];
    for await (const msg of transport.consume(null, controller.signal)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].raw).toBe("actual data");
  });

  it("handles heartbeat events (empty data)", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      reconnect: noReconnect,
      logger,
    });

    mockFetchOk(sseStream("data: \n\ndata: real\n\n"));

    const controller = new AbortController();
    const messages = [];
    for await (const msg of transport.consume(null, controller.signal)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0].raw).toBe("");
    expect(messages[1].raw).toBe("real");
  });

  it("builds URL with filter params + since from cursor", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      filter: { verb: "completed", activity: "course-1" },
      reconnect: noReconnect,
      logger,
    });

    mockFetchOk(sseStream("data: x\n\n"));

    const controller = new AbortController();
    const cursor = { lastEventId: "id-99", since: "2024-01-01T00:00:00Z" };
    for await (const _msg of transport.consume(cursor, controller.signal)) {
      // consume
    }

    const calledUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(calledUrl.searchParams.get("verb")).toBe("completed");
    expect(calledUrl.searchParams.get("activity")).toBe("course-1");
    expect(calledUrl.searchParams.get("since")).toBe("2024-01-01T00:00:00Z");
  });

  it("sets Authorization header (Basic)", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      auth: { basic: { username: "user", password: "pass" } },
      reconnect: noReconnect,
      logger,
    });

    mockFetchOk(sseStream("data: x\n\n"));

    const controller = new AbortController();
    for await (const _msg of transport.consume(null, controller.signal)) {
      // consume
    }

    const headers = fetchMock.mock.calls[0][1].headers;
    const expected = `Basic ${Buffer.from("user:pass").toString("base64")}`;
    expect(headers["Authorization"]).toBe(expected);
  });

  it("sets Authorization header (Bearer)", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      auth: { bearer: "my-token" },
      reconnect: noReconnect,
      logger,
    });

    mockFetchOk(sseStream("data: x\n\n"));

    const controller = new AbortController();
    for await (const _msg of transport.consume(null, controller.signal)) {
      // consume
    }

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer my-token");
  });

  it("sets Last-Event-ID header from cursor", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      reconnect: noReconnect,
      logger,
    });

    mockFetchOk(sseStream("data: x\n\n"));

    const controller = new AbortController();
    for await (const _msg of transport.consume({ lastEventId: "prev-99" }, controller.signal)) {
      // consume
    }

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Last-Event-ID"]).toBe("prev-99");
  });

  it("sets Accept: text/event-stream header", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      reconnect: noReconnect,
      logger,
    });

    mockFetchOk(sseStream("data: x\n\n"));

    const controller = new AbortController();
    for await (const _msg of transport.consume(null, controller.signal)) {
      // consume
    }

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Accept"]).toBe("text/event-stream");
  });

  it("yields messages with cursor containing lastEventId + since", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      reconnect: noReconnect,
      logger,
    });

    mockFetchOk(sseStream("id: event-1\ndata: first\n\nid: event-2\ndata: second\n\n"));

    const controller = new AbortController();
    const messages = [];
    for await (const msg of transport.consume(null, controller.signal)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0].cursor.lastEventId).toBe("event-1");
    expect(messages[0].cursor.since).toBeDefined();
    expect(messages[1].cursor.lastEventId).toBe("event-2");
    expect(messages[1].cursor.since).toBeDefined();
  });

  it("reconnects on disconnect with exponential backoff", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      reconnect: { initialBackoffMs: 1, maxBackoffMs: 10, maxRetries: 2 },
      logger,
    });

    // 3 rejections, then default (undefined) for any subsequent call
    fetchMock
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockRejectedValueOnce(new Error("connection refused"));

    const controller = new AbortController();
    const messages = [];
    for await (const msg of transport.consume(null, controller.signal)) {
      messages.push(msg);
    }

    // initial + 2 retries = 3 fetch calls (retries 1,2 allowed; retry 3 > maxRetries=2 → stop)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(messages).toHaveLength(0);
    // Should have logged the max retries error
    expect(logger.error).toHaveBeenCalled();
  });

  it("stops reconnection when AbortSignal fires", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      reconnect: { initialBackoffMs: 200 },
      logger,
    });

    mockFetchOk(sseStream("data: first\n\n"));

    const controller = new AbortController();
    const messages = [];

    // Abort quickly during reconnect backoff
    setTimeout(() => controller.abort(), 50);

    for await (const msg of transport.consume(null, controller.signal)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(1);
    // Only 1 fetch call — abort stopped reconnection during backoff
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs connection and error events via logger", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      reconnect: { initialBackoffMs: 1, maxRetries: 1 },
      logger,
    });

    // First call succeeds, stream ends; second call fails
    mockFetchOk(sseStream("data: hello\n\n"));
    fetchMock.mockRejectedValueOnce(new Error("fail"));

    const controller = new AbortController();
    for await (const _msg of transport.consume(null, controller.signal)) {
      // consume
    }

    // Should have logged connection info
    expect(logger.info).toHaveBeenCalled();
    // Should have logged the stream end or error
    expect(logger.warn).toHaveBeenCalled();
  });

  it("acknowledge is a no-op", async () => {
    const logger = createLogger();
    const transport = sseTransport({ url: "http://example.com/stream", logger });

    // Should not throw
    await transport.acknowledge({ raw: "data", cursor: {} });
  });

  it("close is a no-op", async () => {
    const logger = createLogger();
    const transport = sseTransport({ url: "http://example.com/stream", logger });

    // Should not throw
    await transport.close();
  });

  it("handles multiple events across chunks", async () => {
    const logger = createLogger();
    const transport = sseTransport({
      url: "http://example.com/stream",
      reconnect: noReconnect,
      logger,
    });

    mockFetchOk(
      chunkedSseStream([
        "data: fir",
        "st\n\ndata: sec",
        "ond\n\n",
      ]),
    );

    const controller = new AbortController();
    const messages = [];
    for await (const msg of transport.consume(null, controller.signal)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0].raw).toBe("first");
    expect(messages[1].raw).toBe("second");
  });
});
