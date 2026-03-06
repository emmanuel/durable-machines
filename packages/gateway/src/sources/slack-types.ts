/** Slack interactive payload (button click, modal submission, etc.) */
export interface SlackInteractivePayload {
  /** Interaction type (e.g. `"block_actions"`, `"view_submission"`). */
  type: string;
  /** Short-lived token for opening modals. */
  trigger_id: string;
  /** Legacy callback identifier. */
  callback_id?: string;
  /** Timestamp of the action. */
  action_ts?: string;
  /** Timestamp of the originating message. */
  message_ts?: string;
  /** Channel where the interaction occurred. */
  channel?: { id: string; name: string };
  /** User who triggered the interaction. */
  user: { id: string; username: string; name?: string };
  /** Workspace the interaction belongs to. */
  team: { id: string; domain: string };
  /** Actions triggered (present for `block_actions` type). */
  actions?: SlackAction[];
  /** Modal view data (present for `view_submission` type). */
  view?: SlackView;
  /** Additional provider-specific fields. */
  [key: string]: unknown;
}

/** A single action element within a Slack interactive payload. */
export interface SlackAction {
  /** Unique identifier for this action element. */
  action_id: string;
  /** Block containing this action. */
  block_id: string;
  /** Action element type (e.g. `"button"`, `"static_select"`). */
  type: string;
  /** Value attached to the action (buttons). */
  value?: string;
  /** Selected menu option (select menus). */
  selected_option?: { value: string };
  /** Additional provider-specific fields. */
  [key: string]: unknown;
}

/** Slack modal view data. */
export interface SlackView {
  /** Unique view identifier. */
  id: string;
  /** View type (e.g. `"modal"`). */
  type: string;
  /** Callback identifier used to route view submissions. */
  callback_id: string;
  /** Opaque metadata string passed through the modal lifecycle. */
  private_metadata?: string;
  /** Form input values keyed by block ID and action ID. */
  state?: { values: Record<string, Record<string, { value: string | null }>> };
  /** Additional provider-specific fields. */
  [key: string]: unknown;
}

/** Slack slash command form data. */
export interface SlackSlashCommandPayload {
  /** The slash command name (e.g. `"/deploy"`). */
  command: string;
  /** Everything after the command name. */
  text: string;
  /** Short-lived token for opening modals. */
  trigger_id: string;
  /** ID of the user who invoked the command. */
  user_id: string;
  /** Username of the invoking user. */
  user_name: string;
  /** Channel ID where the command was issued. */
  channel_id: string;
  /** Channel name where the command was issued. */
  channel_name: string;
  /** Workspace ID. */
  team_id: string;
  /** Workspace domain. */
  team_domain: string;
  /** URL for sending delayed responses (up to 30 minutes). */
  response_url: string;
  /** Additional form fields. */
  [key: string]: string;
}
