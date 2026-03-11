import { verifyHmac } from "../hmac.js";
import { WebhookVerificationError } from "../types.js";
import type { WebhookSource, RawRequest } from "../types.js";
import type { SlackInteractivePayload } from "./slack-types.js";

const MAX_TIMESTAMP_AGE_S = 5 * 60; // 5 minutes

/**
 * Slack interactive webhook source (buttons, modals, etc.).
 * Verifies HMAC-SHA256 signature and rejects replays older than 5 minutes.
 *
 * @param signingSecret - Slack app signing secret.
 * @returns A {@link WebhookSource} for Slack interactive payloads.
 * @throws {WebhookVerificationError} On missing headers, stale timestamp, or signature mismatch.
 */
export function slackSource(signingSecret: string): WebhookSource<SlackInteractivePayload> {
  return {
    async verify(req: RawRequest): Promise<void> {
      const timestamp = req.headers["x-slack-request-timestamp"];
      const signature = req.headers["x-slack-signature"];

      if (!timestamp || !signature) {
        throw new WebhookVerificationError(
          "Missing x-slack-request-timestamp or x-slack-signature header",
          "slack",
        );
      }

      // Replay protection
      const ts = parseInt(timestamp, 10);
      if (Number.isNaN(ts)) {
        throw new WebhookVerificationError("Invalid timestamp", "slack");
      }
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - ts) > MAX_TIMESTAMP_AGE_S) {
        throw new WebhookVerificationError("Timestamp too old", "slack");
      }

      // HMAC verification
      const basestring = `v0:${timestamp}:${req.body}`;
      const expected = signature.replace(/^v0=/, "");
      verifyHmac("sha256", signingSecret, basestring, expected, "slack");
    },

    async parse(req: RawRequest): Promise<SlackInteractivePayload> {
      // Slack sends URL-encoded form with a "payload" JSON field
      const params = new URLSearchParams(req.body);
      const payloadStr = params.get("payload");
      if (!payloadStr) {
        throw new Error("Missing payload field in Slack request body");
      }
      return JSON.parse(payloadStr) as SlackInteractivePayload;
    },
  };
}
