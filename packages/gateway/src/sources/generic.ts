import type { WebhookSource, RawRequest } from "../types.js";

/**
 * Generic webhook source with no verification.
 * For development and testing only.
 *
 * @returns A {@link WebhookSource} that skips verification and JSON-parses the body.
 */
export function genericSource<TPayload = unknown>(): WebhookSource<TPayload> {
  console.warn(
    "[durable-xstate] WARNING: genericSource() has no webhook verification. " +
      "Do NOT use in production.",
  );

  return {
    async verify(_req: RawRequest): Promise<void> {
      // No verification — dev/testing only
    },
    async parse(req: RawRequest): Promise<TPayload> {
      return JSON.parse(req.body) as TPayload;
    },
  };
}
