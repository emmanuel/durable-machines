import type { WebhookSource, RawRequest } from "../types.js";

/**
 * Generic webhook source with no verification.
 * For development and testing only.
 */
export function genericSource<TPayload = unknown>(): WebhookSource<TPayload> {
  return {
    async verify(_req: RawRequest): Promise<void> {
      // No verification — dev/testing only
    },
    async parse(req: RawRequest): Promise<TPayload> {
      return JSON.parse(req.body) as TPayload;
    },
  };
}
