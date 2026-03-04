import { verifyHmac } from "../hmac.js";
import { WebhookVerificationError } from "../types.js";
import type { WebhookSource, RawRequest } from "../types.js";
import type { GitHubWebhookEvent } from "./github-types.js";

/**
 * GitHub webhook source.
 * Verifies `x-hub-signature-256` header (format: `sha256={hex}`).
 */
export function githubSource(webhookSecret: string): WebhookSource<GitHubWebhookEvent> {
  return {
    async verify(req: RawRequest): Promise<void> {
      const signature = req.headers["x-hub-signature-256"];
      if (!signature) {
        throw new WebhookVerificationError(
          "Missing x-hub-signature-256 header",
          "github",
        );
      }

      const hex = signature.replace(/^sha256=/, "");
      verifyHmac("sha256", webhookSecret, req.body, hex, "github");
    },

    async parse(req: RawRequest): Promise<GitHubWebhookEvent> {
      return {
        event: req.headers["x-github-event"] || "unknown",
        deliveryId: req.headers["x-github-delivery"] || "",
        payload: JSON.parse(req.body) as Record<string, unknown>,
      };
    },
  };
}
