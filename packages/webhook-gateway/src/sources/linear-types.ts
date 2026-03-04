/** Linear webhook event. */
export interface LinearWebhookEvent {
  action: string;
  type: string;
  data: Record<string, unknown>;
  updatedFrom?: Record<string, unknown>;
  createdAt: string;
  organizationId?: string;
  webhookId?: string;
  webhookTimestamp: number;
  url?: string;
  [key: string]: unknown;
}
