import type { WebhookRouter, RouteResult } from "../types.js";

/**
 * Routes by extracting workflow ID(s) from payload fields.
 * The extractFn should return a string, array of strings, or null.
 *
 * @param extractFn - Pure function that pulls workflow ID(s) from the payload.
 * @returns A {@link WebhookRouter} that delegates to `extractFn`.
 */
export function fieldRouter<TPayload>(
  extractFn: (payload: TPayload) => RouteResult,
): WebhookRouter<TPayload> {
  return {
    route(payload: TPayload): RouteResult {
      return extractFn(payload);
    },
  };
}
