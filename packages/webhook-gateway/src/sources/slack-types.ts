/** Slack interactive payload (button click, modal submission, etc.) */
export interface SlackInteractivePayload {
  type: string;
  trigger_id: string;
  callback_id?: string;
  action_ts?: string;
  message_ts?: string;
  channel?: { id: string; name: string };
  user: { id: string; username: string; name?: string };
  team: { id: string; domain: string };
  actions?: SlackAction[];
  view?: SlackView;
  [key: string]: unknown;
}

export interface SlackAction {
  action_id: string;
  block_id: string;
  type: string;
  value?: string;
  selected_option?: { value: string };
  [key: string]: unknown;
}

export interface SlackView {
  id: string;
  type: string;
  callback_id: string;
  private_metadata?: string;
  state?: { values: Record<string, Record<string, { value: string | null }>> };
  [key: string]: unknown;
}

/** Slack slash command form data. */
export interface SlackSlashCommandPayload {
  command: string;
  text: string;
  trigger_id: string;
  user_id: string;
  user_name: string;
  channel_id: string;
  channel_name: string;
  team_id: string;
  team_domain: string;
  response_url: string;
  [key: string]: string;
}
