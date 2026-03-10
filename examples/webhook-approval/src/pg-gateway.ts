import pg from "pg";
import {
  slackSource,
  genericSource,
  fieldRouter,
  directTransform,
} from "@durable-xstate/gateway";
import { parseGatewayConfig } from "@durable-xstate/gateway";
import {
  createPgGatewayContext,
  startPgGateway,
} from "@durable-xstate/gateway/pg";
import type { SlackInteractivePayload } from "@durable-xstate/gateway";

interface GenericPayload {
  workflowId?: string;
  event?: string;
  data?: Record<string, unknown>;
}

// Phase 1: config
const config = {
  ...parseGatewayConfig(),
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET ?? "dev-secret",
};

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

// Phase 2: context
const ctx = await createPgGatewayContext(config, pool, {
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
startPgGateway(ctx);
