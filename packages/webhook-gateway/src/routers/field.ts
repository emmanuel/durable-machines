import type { WebhookRouter, RouteResult } from "../types.js";

/**
 * Routes by extracting workflow ID(s) from payload fields.
 * The extractFn should return a string, array of strings, or null.
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
