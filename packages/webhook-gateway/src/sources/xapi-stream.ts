import type { ItemRouter, ItemTransform } from "../types.js";
import type { Logger, StreamBinding } from "../streams/types.js";
import type { SseTransportOptions } from "../streams/sse-transport.js";
import { sseTransport } from "../streams/sse-transport.js";
import type { XapiStatement } from "./xapi-types.js";

export interface XapiStreamBindingConfig {
  url: string;
  auth: { basic?: { username: string; password: string }; bearer?: string };
  filter?: Record<string, string>;
  router: ItemRouter<XapiStatement>;
  transform: ItemTransform<XapiStatement>;
  headers?: Record<string, string>;
  reconnect?: SseTransportOptions["reconnect"];
  logger: Logger;
}

/**
 * Creates an xAPI SSE stream binding.
 *
 * Connects to an xAPI LRS streaming endpoint, parses statements from SSE
 * events, and fans out to workflows via per-statement routing.
 */
export function xapiStreamBinding(
  config: XapiStreamBindingConfig,
): StreamBinding<string, XapiStatement> {
  const transport = sseTransport({
    url: config.url,
    auth: config.auth,
    headers: {
      "X-Experience-API-Version": "1.0.3",
      ...config.headers,
    },
    filter: config.filter,
    reconnect: config.reconnect,
    logger: config.logger,
  });

  const streamId = buildStreamId(config.url, config.filter);

  return {
    streamId,
    transport,
    parse(data: string): XapiStatement[] {
      if (!data || !data.trim()) return [];
      try {
        const parsed: unknown = JSON.parse(data);
        if (Array.isArray(parsed)) return parsed as XapiStatement[];
        return [parsed as XapiStatement];
      } catch {
        return [];
      }
    },
    router: config.router,
    transform: config.transform,
  };
}

/** Generates a deterministic stream ID from URL + sorted filter params. */
function buildStreamId(
  url: string,
  filter: Record<string, string> | undefined,
): string {
  const u = new URL(url);
  // Use origin + pathname as the base (ignore existing query params from the URL)
  let id = `${u.origin}${u.pathname}`;
  if (filter) {
    const sorted = Object.entries(filter)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    if (sorted) {
      id += `?${sorted}`;
    }
  }
  return id;
}
