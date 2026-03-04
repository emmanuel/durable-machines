/** Stripe webhook event. */
export interface StripeWebhookEvent {
  id: string;
  object: "event";
  type: string;
  api_version: string;
  created: number;
  data: {
    object: Record<string, unknown>;
    previous_attributes?: Record<string, unknown>;
  };
  livemode: boolean;
  pending_webhooks: number;
  request: { id: string | null; idempotency_key: string | null } | null;
  [key: string]: unknown;
}
