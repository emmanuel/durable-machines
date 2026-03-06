import type {
  ChannelAdapter,
  SendPromptParams,
  ResolvePromptParams,
  UpdatePromptParams,
  PromptConfig,
  PromptOption,
  FormField,
} from "../types.js";

/** Configuration for the Slack channel adapter. */
export interface SlackChannelOptions {
  /** Slack bot OAuth token (`xoxb-…`). */
  botToken: string;
  /** Fallback channel ID used when the prompt has no recipient. */
  defaultChannel?: string;
}

/** Handle returned by {@link slackChannel} after sending a prompt. */
export interface SlackPromptHandle {
  channel: string;
  ts: string;
}

/**
 * Creates a Slack channel adapter that delivers prompts as Block Kit messages.
 *
 * @param options - Slack bot token and optional default channel.
 * @returns A {@link ChannelAdapter} that sends prompts via `chat.postMessage`.
 *
 * @example
 * ```ts
 * import { slackChannel } from "@durable-xstate/durable-machine";
 *
 * const channel = slackChannel({
 *   botToken: process.env.SLACK_BOT_TOKEN!,
 *   defaultChannel: "C01234ABCDE",
 * });
 * ```
 */
export function slackChannel(options: SlackChannelOptions): ChannelAdapter {
  const { botToken, defaultChannel } = options;

  return {
    async sendPrompt(params: SendPromptParams) {
      const recipient = resolveRecipient(params.prompt, params.context, defaultChannel);
      const text = resolveText(params.prompt, params.context);
      const blocks = renderBlocks(params.prompt, params.workflowId, text);

      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ channel: recipient, text, blocks }),
      });

      const data = (await res.json()) as { ok: boolean; ts?: string; channel?: string; error?: string };
      if (!data.ok) {
        throw new Error(`Slack chat.postMessage failed: ${data.error ?? "unknown"}`);
      }

      const handle: SlackPromptHandle = { channel: data.channel!, ts: data.ts! };
      return { handle };
    },

    async resolvePrompt(params: ResolvePromptParams) {
      const handle = params.handle as SlackPromptHandle;
      const resolvedText = `Resolved: *${params.event.type}*`;

      await fetch("https://slack.com/api/chat.update", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: handle.channel,
          ts: handle.ts,
          text: resolvedText,
          blocks: [{ type: "section", text: { type: "mrkdwn", text: resolvedText } }],
        }),
      });
    },

    async updatePrompt(params: UpdatePromptParams) {
      const handle = params.handle as SlackPromptHandle;
      const text = resolveText(params.prompt, params.context);
      const blocks = renderBlocks(params.prompt, "", text);

      await fetch("https://slack.com/api/chat.update", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: handle.channel,
          ts: handle.ts,
          text,
          blocks,
        }),
      });
    },
  };
}

// --- Internal helpers ---

function resolveRecipient(
  prompt: PromptConfig,
  context: Record<string, unknown>,
  fallback?: string,
): string {
  const r = prompt.recipient;
  if (typeof r === "function") return r({ context });
  if (typeof r === "string") return r;
  if (fallback) return fallback;
  throw new Error("No recipient specified and no defaultChannel configured");
}

function resolveText(prompt: PromptConfig, context: Record<string, unknown>): string {
  const t = prompt.text;
  return typeof t === "function" ? t({ context }) : t;
}

function buttonStyle(style?: PromptOption["style"]): string | undefined {
  if (style === "primary") return "primary";
  if (style === "danger") return "danger";
  return undefined;
}

function renderBlocks(prompt: PromptConfig, workflowId: string, text: string): unknown[] {
  const sectionBlock = {
    type: "section",
    text: { type: "mrkdwn", text },
  };

  switch (prompt.type) {
    case "choice":
      return [
        sectionBlock,
        {
          type: "actions",
          elements: prompt.options.map((opt) => {
            const btn: Record<string, unknown> = {
              type: "button",
              text: { type: "plain_text", text: opt.label },
              action_id: opt.event,
              value: workflowId,
            };
            const style = buttonStyle(opt.style);
            if (style) btn.style = style;
            return btn;
          }),
        },
      ];

    case "confirm":
      return [
        sectionBlock,
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Confirm" },
              action_id: prompt.confirmEvent,
              value: workflowId,
              style: "primary",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Cancel" },
              action_id: prompt.cancelEvent,
              value: workflowId,
              style: "danger",
            },
          ],
        },
      ];

    case "text_input":
      return [
        sectionBlock,
        {
          type: "input",
          element: {
            type: "plain_text_input",
            action_id: prompt.event,
            ...(prompt.placeholder ? { placeholder: { type: "plain_text", text: prompt.placeholder } } : {}),
          },
          label: { type: "plain_text", text: " " },
        },
      ];

    case "form":
      return [
        sectionBlock,
        ...prompt.fields.map((field) => renderFormInput(field, prompt.event)),
      ];
  }
}

function renderFormInput(field: FormField, _event: string): unknown {
  switch (field.type) {
    case "select":
      return {
        type: "input",
        label: { type: "plain_text", text: field.label },
        optional: !field.required,
        element: {
          type: "static_select",
          action_id: field.name,
          options: (field.options ?? []).map((opt) => ({
            text: { type: "plain_text", text: opt },
            value: opt,
          })),
        },
      };

    default:
      return {
        type: "input",
        label: { type: "plain_text", text: field.label },
        optional: !field.required,
        element: {
          type: "plain_text_input",
          action_id: field.name,
        },
      };
  }
}
