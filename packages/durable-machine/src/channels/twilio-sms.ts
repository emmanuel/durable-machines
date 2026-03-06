import type {
  ChannelAdapter,
  SendPromptParams,
  ResolvePromptParams,
  PromptConfig,
} from "../types.js";

/** Configuration for the Twilio SMS channel adapter. */
export interface TwilioSmsChannelOptions {
  /** Twilio Account SID. */
  accountSid: string;
  /** Twilio Auth Token. */
  authToken: string;
  /** Twilio phone number in E.164 format (e.g. `"+15551234567"`). */
  fromNumber: string;
  /** Fallback phone number when the prompt has no recipient. */
  defaultRecipient?: string;
}

/** Handle returned by {@link twilioSmsChannel} after sending a prompt. */
export interface TwilioSmsPromptHandle {
  messageSid: string;
  to: string;
  workflowId: string;
}

/**
 * Creates a Twilio SMS channel adapter that delivers prompts as text messages.
 *
 * @param options - Twilio credentials and phone number.
 * @returns A {@link ChannelAdapter} that sends prompts via the Twilio Messages API.
 *
 * @example
 * ```ts
 * import { twilioSmsChannel } from "@xstate-durable/durable-machine";
 *
 * const channel = twilioSmsChannel({
 *   accountSid: process.env.TWILIO_ACCOUNT_SID!,
 *   authToken: process.env.TWILIO_AUTH_TOKEN!,
 *   fromNumber: "+15551234567",
 * });
 * ```
 */
export function twilioSmsChannel(options: TwilioSmsChannelOptions): ChannelAdapter {
  const { accountSid, authToken, fromNumber, defaultRecipient } = options;
  const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const authHeader = `Basic ${btoa(`${accountSid}:${authToken}`)}`;

  return {
    async sendPrompt(params: SendPromptParams) {
      const recipient = resolveRecipient(params.prompt, params.context, defaultRecipient);
      const body = renderSmsBody(params.prompt, params.context);

      const form = new URLSearchParams({
        To: recipient,
        From: fromNumber,
        Body: body,
      });

      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });

      const data = (await res.json()) as { sid?: string; status?: string; message?: string };
      if (!data.sid) {
        throw new Error(`Twilio Messages API failed: ${data.message ?? "unknown"}`);
      }

      const handle: TwilioSmsPromptHandle = {
        messageSid: data.sid,
        to: recipient,
        workflowId: params.workflowId,
      };
      return { handle };
    },

    async resolvePrompt(params: ResolvePromptParams) {
      const handle = params.handle as TwilioSmsPromptHandle;

      const form = new URLSearchParams({
        To: handle.to,
        From: fromNumber,
        Body: `Resolved: ${params.event.type}`,
      });

      await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
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
  throw new Error("No recipient specified and no defaultRecipient configured");
}

function resolveText(prompt: PromptConfig, context: Record<string, unknown>): string {
  const t = prompt.text;
  return typeof t === "function" ? t({ context }) : t;
}

function renderSmsBody(prompt: PromptConfig, context: Record<string, unknown>): string {
  const text = resolveText(prompt, context);

  switch (prompt.type) {
    case "choice": {
      const options = prompt.options
        .map((opt, i) => `${i + 1} for ${opt.label}`)
        .join(", ");
      return `${text}\n\nReply ${options}`;
    }

    case "confirm":
      return `${text}\n\nReply YES to confirm, NO to cancel`;

    case "text_input":
      return `${text}\n\nReply with your answer`;

    case "form":
      return `${text}\n\n(Form input is not supported via SMS. Please use the provided link.)`;
  }
}
