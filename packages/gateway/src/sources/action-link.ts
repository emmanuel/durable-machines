import { verifyHmac } from "../hmac.js";
import { WebhookVerificationError } from "../types.js";
import type { WebhookSource, RawRequest } from "../types.js";
import type { ActionLinkPayload } from "./action-link-types.js";

/**
 * Creates a webhook source that verifies signed action links.
 *
 * Action links encode `workflowId`, `event`, a creation timestamp, and an
 * HMAC-SHA256 signature in query parameters. Links expire after `maxAgeSec`
 * (default 24 hours).
 *
 * @param signingSecret - The HMAC secret used to sign action links.
 * @param opts.maxAgeSec - Maximum link age in seconds (default 86400 = 24h).
 * @returns A {@link WebhookSource} that verifies and parses action link requests.
 *
 * @example
 * ```ts
 * import { actionLinkSource } from "@durable-xstate/gateway";
 *
 * const source = actionLinkSource(process.env.ACTION_LINK_SECRET!);
 * ```
 *
 * @throws {WebhookVerificationError} If the signature is missing, invalid, or expired.
 */
export function actionLinkSource(
  signingSecret: string,
  opts?: { maxAgeSec?: number },
): WebhookSource<ActionLinkPayload> {
  const maxAgeMs = (opts?.maxAgeSec ?? 86400) * 1000;

  return {
    async verify(req: RawRequest): Promise<void> {
      const params = parseQueryParams(req);
      const { workflowId, event, sig, t } = params;

      if (!workflowId || !event || !sig) {
        throw new WebhookVerificationError(
          "Missing workflowId, event, or sig query parameter",
          "action-link",
        );
      }

      if (!t) {
        throw new WebhookVerificationError(
          "Missing timestamp — unsigned action links are not accepted",
          "action-link",
        );
      }

      const createdAt = parseInt(t, 10);
      if (Number.isNaN(createdAt)) {
        throw new WebhookVerificationError("Invalid timestamp", "action-link");
      }
      if (Date.now() - createdAt > maxAgeMs) {
        throw new WebhookVerificationError("Action link expired", "action-link");
      }

      verifyHmac("sha256", signingSecret, `${workflowId}:${event}:${createdAt}`, sig, "action-link");
    },

    async parse(req: RawRequest): Promise<ActionLinkPayload> {
      const params = parseQueryParams(req);
      return {
        workflowId: params.workflowId!,
        event: params.event!,
      };
    },
  };
}

function parseQueryParams(req: RawRequest): Record<string, string | undefined> {
  // Action links arrive as GET requests with query params in the body
  // or as POST requests with form-encoded body
  const searchParams = new URLSearchParams(req.body);
  return {
    workflowId: searchParams.get("workflowId") ?? undefined,
    event: searchParams.get("event") ?? undefined,
    sig: searchParams.get("sig") ?? undefined,
    t: searchParams.get("t") ?? undefined,
  };
}
