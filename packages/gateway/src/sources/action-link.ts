import { verifyHmac } from "../hmac.js";
import { WebhookVerificationError } from "../types.js";
import type { WebhookSource, RawRequest } from "../types.js";
import type { ActionLinkPayload } from "./action-link-types.js";

/**
 * Creates a webhook source that verifies signed action links.
 *
 * Action links encode `workflowId`, `event`, and an HMAC-SHA256 signature
 * in query parameters. This source is used by the email channel adapter
 * but works with any channel that uses signed HTTP links.
 *
 * @param signingSecret - The HMAC secret used to sign action links.
 * @returns A {@link WebhookSource} that verifies and parses action link requests.
 *
 * @example
 * ```ts
 * import { actionLinkSource } from "@durable-xstate/gateway";
 *
 * const source = actionLinkSource(process.env.ACTION_LINK_SECRET!);
 * ```
 *
 * @throws {WebhookVerificationError} If the signature is missing or invalid.
 */
export function actionLinkSource(signingSecret: string): WebhookSource<ActionLinkPayload> {
  return {
    async verify(req: RawRequest): Promise<void> {
      const params = parseQueryParams(req);
      const { workflowId, event, sig } = params;

      if (!workflowId || !event || !sig) {
        throw new WebhookVerificationError(
          "Missing workflowId, event, or sig query parameter",
          "action-link",
        );
      }

      verifyHmac("sha256", signingSecret, workflowId + event, sig, "action-link");
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
  };
}
