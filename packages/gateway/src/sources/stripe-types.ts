/** Stripe webhook event. */
export interface StripeWebhookEvent {
  /** Unique event identifier (e.g. `"evt_1..."` ). */
  id: string;
  /** Always `"event"`. */
  object: "event";
  /** Dot-delimited event type (e.g. `"invoice.paid"`). */
  type: string;
  /** Stripe API version used to render the event. */
  api_version: string;
  /** Unix timestamp (seconds) when the event was created. */
  created: number;
  /** Event payload containing the affected object and optional previous state. */
  data: {
    /** The Stripe object that triggered the event. */
    object: Record<string, unknown>;
    /** Fields that changed (present on `*.updated` events). */
    previous_attributes?: Record<string, unknown>;
  };
  /** `true` for live-mode events, `false` for test-mode. */
  livemode: boolean;
  /** Number of webhook endpoints yet to receive this event. */
  pending_webhooks: number;
  /** API request that triggered the event, if any. */
  request: { id: string | null; idempotency_key: string | null } | null;
  /** Additional provider-specific fields. */
  [key: string]: unknown;
}
