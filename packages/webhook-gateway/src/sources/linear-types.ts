/** Linear webhook event. */
export interface LinearWebhookEvent {
  /** Mutation type (e.g. `"create"`, `"update"`, `"remove"`). */
  action: string;
  /** Resource type (e.g. `"Issue"`, `"Comment"`, `"Project"`). */
  type: string;
  /** The affected resource data. */
  data: Record<string, unknown>;
  /** Previous field values (present on `"update"` actions). */
  updatedFrom?: Record<string, unknown>;
  /** ISO 8601 timestamp of the event. */
  createdAt: string;
  /** Organization the event belongs to. */
  organizationId?: string;
  /** ID of the webhook configuration that produced this event. */
  webhookId?: string;
  /** Unix timestamp (ms) for replay protection. */
  webhookTimestamp: number;
  /** URL of the affected resource in the Linear UI. */
  url?: string;
  /** Additional provider-specific fields. */
  [key: string]: unknown;
}
