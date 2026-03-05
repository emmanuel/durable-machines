import { verifyHmac } from "../hmac.js";
import { WebhookVerificationError } from "../types.js";
import type { WebhookSource, RawRequest } from "../types.js";
import type { CalcomWebhookEvent } from "./calcom-types.js";

/**
 * Cal.com webhook source.
 * Verifies `x-cal-signature-256` header (HMAC-SHA256 hex of raw body).
 *
 * @param webhookSecret - The signing secret configured in Cal.com webhook settings.
 * @returns A {@link WebhookSource} for Cal.com webhook events.
 * @throws {WebhookVerificationError} On missing header or signature mismatch.
 */
export function calcomSource(webhookSecret: string): WebhookSource<CalcomWebhookEvent> {
  return {
    async verify(req: RawRequest): Promise<void> {
      const signature = req.headers["x-cal-signature-256"];
      if (!signature) {
        throw new WebhookVerificationError(
          "Missing x-cal-signature-256 header",
          "calcom",
        );
      }

      verifyHmac("sha256", webhookSecret, req.body, signature, "calcom");
    },

    async parse(req: RawRequest): Promise<CalcomWebhookEvent> {
      return JSON.parse(req.body) as CalcomWebhookEvent;
    },
  };
}
