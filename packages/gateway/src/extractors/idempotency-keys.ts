import type { RawRequest } from "../types.js";
import type { StreamCursor } from "../streams/types.js";
import type { StripeWebhookEvent } from "../sources/stripe-types.js";
import type { GitHubWebhookEvent } from "../sources/github-types.js";
import type { TwilioInboundSms } from "../sources/twilio-types.js";
import type { CalcomWebhookEvent } from "../sources/calcom-types.js";
import type { XapiStatement } from "../sources/xapi-types.js";
import type { LinearWebhookEvent } from "../sources/linear-types.js";
import type { ActionLinkPayload } from "../sources/action-link-types.js";

/** Stripe: unique event ID (e.g. `evt_1...`). */
export function stripeIdempotencyKey(item: StripeWebhookEvent): string | undefined {
  return item.id;
}

/** GitHub: delivery ID from `x-github-delivery` header. */
export function githubIdempotencyKey(item: GitHubWebhookEvent): string | undefined {
  return item.deliveryId;
}

/** Twilio: unique message SID. */
export function twilioIdempotencyKey(item: TwilioInboundSms): string | undefined {
  return item.MessageSid;
}

/** Cal.com: unique booking UID from nested payload. */
export function calcomIdempotencyKey(item: CalcomWebhookEvent): string | undefined {
  return item.payload?.uid;
}

/** xAPI: optional statement UUID. Returns undefined if absent. */
export function xapiIdempotencyKey(item: XapiStatement): string | undefined {
  return item.id;
}

/** Linear: composite key from data ID + action + timestamp. Returns undefined if data.id is absent. */
export function linearIdempotencyKey(item: LinearWebhookEvent): string | undefined {
  const dataId = (item.data as Record<string, unknown>)?.id;
  if (!dataId) return undefined;
  return `${dataId}:${item.action}:${item.createdAt}`;
}

/** Action Link: HMAC signature from header is unique per invocation. */
export function actionLinkIdempotencyKey(_item: ActionLinkPayload, req: RawRequest): string | undefined {
  return req.headers["x-action-link-signature"];
}

/** xAPI stream: statement ID or fallback to cursor-based composite key. */
export function xapiStreamIdempotencyKey(item: XapiStatement, cursor: StreamCursor): string | undefined {
  return item.id ?? `${(cursor as Record<string, unknown>).lastEventId}:${item.verb?.id}`;
}
