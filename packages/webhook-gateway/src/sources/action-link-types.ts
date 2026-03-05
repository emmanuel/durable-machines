/** Parsed payload from a signed action link (e.g. email callback). */
export interface ActionLinkPayload {
  /** The workflow instance ID to route the event to. */
  workflowId: string;
  /** The event type to dispatch (e.g. `"APPROVE"`). */
  event: string;
}
