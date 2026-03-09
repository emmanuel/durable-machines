import {
  parseDBOSGatewayConfig,
  createDBOSGatewayContext,
  startDBOSGateway,
  slackSource,
  genericSource,
  fieldRouter,
  directTransform,
} from "@durable-xstate/gateway";
import type { SlackInteractivePayload } from "@durable-xstate/gateway";

interface GenericPayload {
  workflowId?: string;
  event?: string;
  data?: Record<string, unknown>;
}

// Phase 1: config (all env reads here)
const config = {
  ...parseDBOSGatewayConfig(),
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET ?? "dev-secret",
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
  ],
});

// Phase 3: start
startDBOSGateway(ctx);
