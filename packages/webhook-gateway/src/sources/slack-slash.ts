import { computeHmac } from "../hmac.js";
import { WebhookVerificationError } from "../types.js";
import type {
  WebhookSource,
  WebhookBinding,
  ItemRouter,
  ItemTransform,
  XStateEvent,
  RawRequest,
  GatewayClient,
} from "../types.js";
import type { SlackSlashCommandPayload } from "./slack-types.js";

const MAX_TIMESTAMP_AGE_S = 5 * 60;

/** Configuration for a Slack slash command binding. */
export interface SlashCommandConfig {
  /** Maps subcommand names to XState event types. */
  eventMap: Record<string, string>;
  /** Signing secret for HMAC verification. */
  signingSecret: string;
  /** Text to respond with immediately (3-second ack). Defaults to a generic message. */
  ackText?: string;
}

/** Internal representation of a parsed `/command subcommand workflowId --key value` invocation. */
interface ParsedSlashCommand {
  /** First token after the command name. */
  subcommand: string;
  /** Second token, interpreted as the target workflow ID. */
  workflowId: string;
  /** Remaining `--key value` pairs. */
  args: Record<string, string>;
  /** Original Slack form data. */
  raw: SlackSlashCommandPayload;
}

function parseCommandText(text: string): {
  subcommand: string;
  workflowId: string;
  args: Record<string, string>;
} {
  const parts = text.trim().split(/\s+/);
  const subcommand = parts[0] || "";
  const workflowId = parts[1] || "";
  const args: Record<string, string> = {};

  for (let i = 2; i < parts.length; i++) {
    if (parts[i].startsWith("--") && i + 1 < parts.length) {
      args[parts[i].slice(2)] = parts[i + 1];
      i++;
    }
  }

  return { subcommand, workflowId, args };
}

/**
 * Creates a Slack slash command source with HMAC verification.
 */
function slashCommandSource(signingSecret: string): WebhookSource<ParsedSlashCommand> {
  return {
    async verify(req: RawRequest): Promise<void> {
      const timestamp = req.headers["x-slack-request-timestamp"];
      const signature = req.headers["x-slack-signature"];

      if (!timestamp || !signature) {
        throw new WebhookVerificationError(
          "Missing x-slack-request-timestamp or x-slack-signature header",
          "slack-slash",
        );
      }

      const ts = parseInt(timestamp, 10);
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - ts) > MAX_TIMESTAMP_AGE_S) {
        throw new WebhookVerificationError("Timestamp too old", "slack-slash");
      }

      const basestring = `v0:${timestamp}:${req.body}`;
      const computed = computeHmac("sha256", signingSecret, basestring);
      const expected = signature.replace(/^v0=/, "");

      const expectedBuf = Buffer.from(expected, "hex");
      const computedBuf = Buffer.from(computed, "hex");

      if (expectedBuf.length !== computedBuf.length) {
        throw new WebhookVerificationError("Signature mismatch", "slack-slash");
      }

      const { timingSafeEqual } = await import("node:crypto");
      if (!timingSafeEqual(expectedBuf, computedBuf)) {
        throw new WebhookVerificationError("Signature mismatch", "slack-slash");
      }
    },

    async parse(req: RawRequest): Promise<ParsedSlashCommand> {
      const params = new URLSearchParams(req.body);
      const raw: SlackSlashCommandPayload = {} as SlackSlashCommandPayload;
      for (const [key, value] of params.entries()) {
        (raw as Record<string, string>)[key] = value;
      }
      const { subcommand, workflowId, args } = parseCommandText(raw.text || "");
      return { subcommand, workflowId, args, raw };
    },
  };
}

/**
 * Creates a complete slash command binding with routing, transform, and status handling.
 *
 * @param path - URL path to mount (e.g. `"/slash/deploy"`).
 * @param config - Slash command configuration (event map, signing secret, ack text).
 * @param client - Gateway client used for status lookups and event dispatch.
 * @returns A {@link WebhookBinding} wired with source, router, transform, and `onResponse`.
 */
export function slashCommandBinding(
  path: string,
  config: SlashCommandConfig,
  client: GatewayClient,
): WebhookBinding<ParsedSlashCommand> {
  const source = slashCommandSource(config.signingSecret);

  const router: ItemRouter<ParsedSlashCommand> = {
    route(payload: ParsedSlashCommand) {
      if (payload.subcommand === "status") {
        return null; // Handled inline via onResponse
      }
      return payload.workflowId || null;
    },
  };

  const transform: ItemTransform<ParsedSlashCommand> = {
    transform(payload: ParsedSlashCommand): XStateEvent {
      const eventType = config.eventMap[payload.subcommand];
      if (!eventType) {
        return { type: payload.subcommand, ...payload.args };
      }
      return { type: eventType, ...payload.args };
    },
  };

  return {
    path,
    source,
    router,
    transform,
    async onResponse(payload, c) {
      if (payload.subcommand === "status") {
        const wfId = payload.workflowId;
        if (!wfId) {
          return c.json({ response_type: "ephemeral", text: "Usage: status <workflowId>" });
        }
        const state = await client.getEvent<unknown>(wfId, "xstate.state", 0.1);
        const text = state ? `Workflow \`${wfId}\`: \`${JSON.stringify(state)}\`` : `Workflow \`${wfId}\`: no state found`;
        return c.json({ response_type: "ephemeral", text });
      }
      // 3-second ack for non-status commands
      const ackText = config.ackText || `Processing \`${payload.subcommand}\` for \`${payload.workflowId}\`...`;
      return c.json({ response_type: "ephemeral", text: ackText });
    },
  };
}
