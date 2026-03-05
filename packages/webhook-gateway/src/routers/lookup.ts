import type { WebhookRouter, RouteResult } from "../types.js";

/**
 * Routes by extracting a key from the payload, then doing an async lookup.
 * Useful for DB lookups to map external IDs to workflow IDs.
 *
 * @param extractKey - Pulls a lookup key (e.g. external ID) from the payload.
 * @param queryFn - Async function that resolves the key to workflow ID(s).
 * @returns A {@link WebhookRouter} that chains extraction and lookup.
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
