import type { WebhookRouter, RouteResult } from "../types.js";

/**
 * Fan-out router that sends to all matching workflows.
 * filterFn extracts a filter key, queryFn returns all matching workflow IDs.
 *
 * @param filterFn - Extracts a filter/group key from the payload.
 * @param queryFn - Returns all workflow IDs that match the filter key.
 * @returns A {@link WebhookRouter} that dispatches to multiple workflows.
 */
export function broadcastRouter<TPayload>(
  filterFn: (payload: TPayload) => string,
  queryFn: (filter: string) => Promise<string[]>,
): WebhookRouter<TPayload> {
  return {
    async route(payload: TPayload): Promise<RouteResult> {
      const filter = filterFn(payload);
      const ids = await queryFn(filter);
      return ids.length > 0 ? ids : null;
    },
  };
}
