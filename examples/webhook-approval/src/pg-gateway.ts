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
import type { DurableMachine } from "@durable-xstate/durable-machine";
import { createDurableMachine, createStore } from "@durable-xstate/durable-machine/pg";
import { approvalMachine } from "./machine.js";
import { recruitingPipeline } from "./recruiting-pipeline.js";

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

// Phase 1: config
const config = {
  ...parseGatewayConfig(),
  slackSigningSecret: requireEnv("SLACK_SIGNING_SECRET"),
};

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

// Register machines for the dashboard + REST API
const store = createStore({ pool, useListenNotify: true });
await store.ensureSchema();
const machines = new Map<string, DurableMachine>();
machines.set("approvals", createDurableMachine(approvalMachine, { pool, store, enableAnalytics: true }));
machines.set("recruiting", createDurableMachine(recruitingPipeline, { pool, store, enableAnalytics: true }));

// Phase 2: context
const ctx = await createPgGatewayContext(config, pool, {
  machines,
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
