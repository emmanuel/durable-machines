import type { ItemTransform, XStateEvent } from "../types.js";

/**
 * Extracts an XState event directly from the payload using the provided function.
 *
 * @param extractFn - Maps the provider payload to an XState event.
 * @returns An {@link ItemTransform} that delegates to `extractFn`.
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
): ItemTransform<TPayload> {
  return {
    transform(payload: TPayload): XStateEvent {
      return extractFn(payload);
    },
  };
}
