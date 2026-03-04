import type { WebhookTransform, XStateEvent } from "../types.js";

/**
 * Extracts an XState event directly from the payload using the provided function.
 */
export function directTransform<TPayload>(
  extractFn: (payload: TPayload) => XStateEvent,
): WebhookTransform<TPayload> {
  return {
    transform(payload: TPayload): XStateEvent {
      return extractFn(payload);
    },
  };
}
