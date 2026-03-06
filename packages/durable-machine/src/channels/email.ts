import { createHmac } from "node:crypto";
import type {
  ChannelAdapter,
  SendPromptParams,
  ResolvePromptParams,
  PromptConfig,
} from "../types.js";

/** Parameters passed to the email-sending callback. */
export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

/** Configuration for the email channel adapter. */
export interface EmailChannelOptions {
  /** Callback that sends an email. Provider-agnostic — use any email service. */
  sendEmail: (params: SendEmailParams) => Promise<void>;
  /** Base URL for action links (e.g. `"https://app.example.com/actions"`). */
  callbackUrl: string;
  /** HMAC secret for signing action link tokens. */
  signingSecret: string;
  /** Fallback email address when the prompt has no recipient. */
  defaultRecipient?: string;
  /** Subject line prefix (e.g. `"[Approval Required]"`). */
  subjectPrefix?: string;
}

/** Handle returned by {@link emailChannel} after sending a prompt. */
export interface EmailPromptHandle {
  to: string;
  workflowId: string;
}

/**
 * Creates an email channel adapter that delivers prompts as HTML emails
 * with signed action links.
 *
 * @param options - Email sending callback, callback URL, and signing secret.
 * @returns A {@link ChannelAdapter} that sends prompts via the provided callback.
 *
 * @example
 * ```ts
 * import { emailChannel } from "@durable-xstate/durable-machine";
 *
 * const channel = emailChannel({
 *   sendEmail: async ({ to, subject, html }) => {
 *     await resend.emails.send({ from: "noreply@app.com", to, subject, html });
 *   },
 *   callbackUrl: "https://app.example.com/actions",
 *   signingSecret: process.env.ACTION_LINK_SECRET!,
 * });
 * ```
 */
export function emailChannel(options: EmailChannelOptions): ChannelAdapter {
  const { sendEmail, callbackUrl, signingSecret, defaultRecipient, subjectPrefix } = options;

  return {
    async sendPrompt(params: SendPromptParams) {
      const recipient = resolveRecipient(params.prompt, params.context, defaultRecipient);
      const text = resolveText(params.prompt, params.context);
      const subject = subjectPrefix ? `${subjectPrefix} ${text}` : text;
      const html = renderHtml(params.prompt, params.workflowId, text, callbackUrl, signingSecret);

      await sendEmail({ to: recipient, subject, html });

      const handle: EmailPromptHandle = { to: recipient, workflowId: params.workflowId };
      return { handle };
    },

    async resolvePrompt(params: ResolvePromptParams) {
      const handle = params.handle as EmailPromptHandle;
      const resolvedHtml = `<p>This action has been resolved: <strong>${escapeHtml(params.event.type)}</strong></p>`;
      const subject = subjectPrefix
        ? `${subjectPrefix} Resolved: ${params.event.type}`
        : `Resolved: ${params.event.type}`;

      await sendEmail({ to: handle.to, subject, html: resolvedHtml });
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

/** Creates an HMAC-SHA256 signature for an action link. */
export function signActionLink(workflowId: string, event: string, secret: string): string {
  return createHmac("sha256", secret).update(workflowId + event).digest("hex");
}

function actionUrl(baseUrl: string, workflowId: string, event: string, secret: string): string {
  const sig = signActionLink(workflowId, event, secret);
  const params = new URLSearchParams({ workflowId, event, sig });
  return `${baseUrl}?${params.toString()}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function styledButton(label: string, href: string, style?: string): string {
  const bg = style === "danger" ? "#dc2626" : "#2563eb";
  const css = `display:inline-block;padding:10px 20px;margin:4px;background:${bg};color:#fff;text-decoration:none;border-radius:4px;font-weight:bold`;
  return `<a href="${escapeHtml(href)}" style="${css}">${escapeHtml(label)}</a>`;
}

function renderHtml(
  prompt: PromptConfig,
  workflowId: string,
  text: string,
  baseUrl: string,
  secret: string,
): string {
  const heading = `<p>${escapeHtml(text)}</p>`;

  switch (prompt.type) {
    case "choice": {
      const buttons = prompt.options.map((opt) =>
        styledButton(opt.label, actionUrl(baseUrl, workflowId, opt.event, secret), opt.style),
      );
      return `${heading}<p>${buttons.join(" ")}</p>`;
    }

    case "confirm": {
      const confirmBtn = styledButton("Confirm", actionUrl(baseUrl, workflowId, prompt.confirmEvent, secret));
      const cancelBtn = styledButton("Cancel", actionUrl(baseUrl, workflowId, prompt.cancelEvent, secret), "danger");
      return `${heading}<p>${confirmBtn} ${cancelBtn}</p>`;
    }

    case "text_input": {
      const link = `<a href="${escapeHtml(actionUrl(baseUrl, workflowId, prompt.event, secret))}">Click here to respond</a>`;
      return `${heading}<p>${link}</p>`;
    }

    case "form": {
      const link = `<a href="${escapeHtml(actionUrl(baseUrl, workflowId, prompt.event, secret))}">Click here to fill out the form</a>`;
      return `${heading}<p>${link}</p>`;
    }
  }
}
