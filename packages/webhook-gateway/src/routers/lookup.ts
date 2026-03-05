import type { ItemRouter, RouteResult } from "../types.js";

/**
 * Routes by extracting a key from the payload, then doing an async lookup.
 * Useful for DB lookups to map external IDs to workflow IDs.
 *
 * @param extractKey - Pulls a lookup key (e.g. external ID) from the payload.
 * @param queryFn - Async function that resolves the key to workflow ID(s).
 * @returns An {@link ItemRouter} that chains extraction and lookup.
 */
export function lookupRouter<TPayload>(
  extractKey: (payload: TPayload) => string,
  queryFn: (key: string) => Promise<RouteResult>,
): ItemRouter<TPayload> {
  return {
    async route(payload: TPayload): Promise<RouteResult> {
      const key = extractKey(payload);
      return queryFn(key);
    },
  };
}
