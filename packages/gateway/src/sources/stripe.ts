import { WebhookVerificationError } from "../types.js";
import { verifyHmac } from "../hmac.js";
import type { WebhookSource, RawRequest } from "../types.js";
import type { StripeWebhookEvent } from "./stripe-types.js";

const MAX_TIMESTAMP_AGE_S = 5 * 60;

/**
 * Stripe webhook source.
 * Verifies `stripe-signature` header (format: `t={timestamp},v1={hex}`).
 *
 * @param webhookSecret - Stripe webhook endpoint secret (starts with `whsec_`).
 * @returns A {@link WebhookSource} for Stripe webhook events.
 * @throws {WebhookVerificationError} On missing header, bad format, stale timestamp, or signature mismatch.
 */
export function stripeSource(webhookSecret: string): WebhookSource<StripeWebhookEvent> {
  return {
    async verify(req: RawRequest): Promise<void> {
      const sigHeader = req.headers["stripe-signature"];
      if (!sigHeader) {
        throw new WebhookVerificationError("Missing stripe-signature header", "stripe");
      }

      const parts = Object.fromEntries(
        sigHeader.split(",").map((part) => {
          const [key, ...rest] = part.split("=");
          return [key, rest.join("=")];
        }),
      );

      const timestamp = parts["t"];
      const v1Signature = parts["v1"];

      if (!timestamp || !v1Signature) {
        throw new WebhookVerificationError(
          "Invalid stripe-signature format",
          "stripe",
        );
      }

      // Replay protection
      const ts = parseInt(timestamp, 10);
      if (Number.isNaN(ts)) {
        throw new WebhookVerificationError("Invalid timestamp", "stripe");
      }
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - ts) > MAX_TIMESTAMP_AGE_S) {
        throw new WebhookVerificationError("Timestamp too old", "stripe");
      }

      // Stripe signs `{timestamp}.{body}`
      const signedPayload = `${timestamp}.${req.body}`;
      verifyHmac("sha256", webhookSecret, signedPayload, v1Signature, "stripe");
    },

    async parse(req: RawRequest): Promise<StripeWebhookEvent> {
      return JSON.parse(req.body) as StripeWebhookEvent;
    },
  };
}
