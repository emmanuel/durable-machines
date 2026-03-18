import {
  slackSource,
  genericSource,
  fieldRouter,
  directTransform,
} from "@durable-machines/gateway";
import {
  parseDBOSGatewayConfig,
  createDBOSGatewayContext,
  startDBOSGateway,
} from "@durable-machines/gateway/dbos";
import type { SlackInteractivePayload } from "@durable-machines/gateway";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

interface GenericPayload {
  workflowId?: string;
  event?: string;
  data?: Record<string, unknown>;
}

// Phase 1: config (all env reads here)
const config = {
  ...parseDBOSGatewayConfig(),
  slackSigningSecret: requireEnv("SLACK_SIGNING_SECRET"),
};

// Phase 2: context (no process.env)
const ctx = await createDBOSGatewayContext(config, {
  bindings: [
    {
      path: "/webhooks/slack",
      source: slackSource(config.slackSigningSecret),
      router: fieldRouter<SlackInteractivePayload>((payload) => {
        const action = payload.actions?.[0];
        return action?.value || null;
      }),
      transform: directTransform<SlackInteractivePayload>((payload) => {
        const action = payload.actions?.[0];
        return { type: action?.action_id || "UNKNOWN" };
      }),
    },
    {
      path: "/webhooks/generic",
      source: genericSource<GenericPayload>(),
      router: fieldRouter<GenericPayload>((payload) => payload.workflowId || null),
      transform: directTransform<GenericPayload>((payload) => ({
        type: payload.event || "UNKNOWN",
        ...payload.data,
      })),
    },
    {
      path: "/webhooks/recruiting",
      source: genericSource<GenericPayload>(),
      router: fieldRouter<GenericPayload>((payload) => payload.workflowId || null),
      transform: directTransform<GenericPayload>((payload) => ({
        type: payload.event || "UNKNOWN",
        ...payload.data,
      })),
    },
  ],
});

// Phase 3: start
startDBOSGateway(ctx);
