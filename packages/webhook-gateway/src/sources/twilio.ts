import { createHmac } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "../types.js";
import type { WebhookSource, RawRequest } from "../types.js";
import type { TwilioInboundSms } from "./twilio-types.js";

/**
 * Creates a webhook source for inbound Twilio SMS messages.
 *
 * Twilio signs webhooks with HMAC-SHA1 using base64 encoding. The signed
 * string is the webhook URL concatenated with sorted POST parameter
 * key-value pairs.
 *
 * @param authToken - Twilio Auth Token used for signature verification.
 * @param webhookUrl - The full public URL of the webhook endpoint (must match
 *   exactly what Twilio is configured to POST to, including protocol and path).
 * @returns A {@link WebhookSource} that verifies and parses Twilio SMS webhooks.
 *
 * @throws {WebhookVerificationError} If the `X-Twilio-Signature` header is
 *   missing or the signature does not match.
 */
export function twilioSource(authToken: string, webhookUrl: string): WebhookSource<TwilioInboundSms> {
  return {
    async verify(req: RawRequest): Promise<void> {
      const signature = req.headers["x-twilio-signature"];
      if (!signature) {
        throw new WebhookVerificationError(
          "Missing X-Twilio-Signature header",
          "twilio",
        );
      }

      // Build the signed string: URL + sorted key-value pairs from POST body
      const params = new URLSearchParams(req.body);
      const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
      let dataToSign = webhookUrl;
      for (const [key, value] of sorted) {
        dataToSign += key + value;
      }

      const computed = createHmac("sha1", authToken)
        .update(dataToSign)
        .digest("base64");

      const expectedBuf = Buffer.from(signature, "base64");
      const computedBuf = Buffer.from(computed, "base64");

      if (expectedBuf.length !== computedBuf.length || !timingSafeEqual(expectedBuf, computedBuf)) {
        throw new WebhookVerificationError("Signature mismatch", "twilio");
      }
    },

    async parse(req: RawRequest): Promise<TwilioInboundSms> {
      const params = new URLSearchParams(req.body);
      return {
        From: params.get("From") ?? "",
        To: params.get("To") ?? "",
        Body: params.get("Body") ?? "",
        MessageSid: params.get("MessageSid") ?? "",
        AccountSid: params.get("AccountSid") ?? "",
      };
    },
  };
}
