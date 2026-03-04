import type { WebhookRouter, RouteResult } from "../types.js";

/**
 * Routes by extracting a key from the payload, then doing an async lookup.
 * Useful for DB lookups to map external IDs to workflow IDs.
 */
export function lookupRouter<TPayload>(
  extractKey: (payload: TPayload) => string,
  queryFn: (key: string) => Promise<RouteResult>,
): WebhookRouter<TPayload> {
  return {
    async route(payload: TPayload): Promise<RouteResult> {
      const key = extractKey(payload);
      return queryFn(key);
    },
  };
}
