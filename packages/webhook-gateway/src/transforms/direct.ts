import type { WebhookTransform, XStateEvent } from "../types.js";

/**
 * Extracts an XState event directly from the payload using the provided function.
 *
 * @param extractFn - Maps the provider payload to an XState event.
 * @returns A {@link WebhookTransform} that delegates to `extractFn`.
 *
 * @example
 * ```ts
 * const transform = directTransform<StripeWebhookEvent>((p) => ({
 *   type: `stripe.${p.type}`,
 *   id: p.id,
 * }));
 * ```
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
