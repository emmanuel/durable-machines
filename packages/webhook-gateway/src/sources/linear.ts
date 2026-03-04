import { verifyHmac } from "../hmac.js";
import { WebhookVerificationError } from "../types.js";
import type { WebhookSource, RawRequest } from "../types.js";
import type { LinearWebhookEvent } from "./linear-types.js";

const MAX_TIMESTAMP_AGE_S = 60; // Linear uses 60 seconds

/**
 * Linear webhook source.
 * Verifies `Linear-Signature` header (HMAC-SHA256 hex of raw body).
 * Rejects payloads older than 60 seconds.
 */
export function linearSource(signingSecret: string): WebhookSource<LinearWebhookEvent> {
  return {
    async verify(req: RawRequest): Promise<void> {
      const signature = req.headers["linear-signature"];
      if (!signature) {
        throw new WebhookVerificationError(
          "Missing Linear-Signature header",
          "linear",
        );
      }

      verifyHmac("sha256", signingSecret, req.body, signature, "linear");

      // Replay protection: check webhookTimestamp in body
      const body = JSON.parse(req.body) as { webhookTimestamp?: number };
      if (body.webhookTimestamp) {
        const now = Date.now();
        if (Math.abs(now - body.webhookTimestamp) > MAX_TIMESTAMP_AGE_S * 1000) {
          throw new WebhookVerificationError("Timestamp too old", "linear");
        }
      }
    },

    async parse(req: RawRequest): Promise<LinearWebhookEvent> {
      return JSON.parse(req.body) as LinearWebhookEvent;
    },
  };
}
