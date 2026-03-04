/** GitHub webhook event, enriched with headers. */
export interface GitHubWebhookEvent {
  /** The event type from x-github-event header. */
  event: string;
  /** Unique delivery ID from x-github-delivery header. */
  deliveryId: string;
  /** The parsed JSON payload. */
  payload: Record<string, unknown>;
}
