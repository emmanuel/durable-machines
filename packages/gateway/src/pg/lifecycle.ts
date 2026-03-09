import type { Pool } from "pg";
import type { Server } from "node:http";
import type { Hono } from "hono";
import type { GatewayMetrics } from "../metrics.js";
import {
  createGatewayContext,
  startGateway,
} from "../lifecycle.js";
import type {
  GatewayConfig,
  GatewayContextOptions,
} from "../lifecycle.js";
import type { GatewayClient } from "../types.js";
import type { StreamConsumerHandle } from "../streams/consumer.js";
import {
  sendMachineEvent,
  sendMachineEventBatch,
  getMachineState,
} from "@durable-xstate/durable-machine/pg";
import { createAppContext } from "@durable-xstate/durable-machine";
import type { AppContext } from "@durable-xstate/durable-machine";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PgGatewayContext {
  config: GatewayConfig;
  client: GatewayClient;
  pool: Pool;
  appContext: AppContext;
  metrics: GatewayMetrics;
  gateway: Hono;
  adminServer: Server;
  checkpointPool?: import("pg").Pool;
  streamConsumers?: StreamConsumerHandle[];
  cleanup?: () => Promise<void>;
}

export interface PgGatewayHandle {
  shutdown(): Promise<void>;
  server: Server;
  adminServer: Server;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createPgGatewayClient(pool: Pool): GatewayClient {
  return {
    send: (workflowId, message, topic) =>
      sendMachineEvent(pool, workflowId, { type: topic, ...message as object }),
    sendBatch: (messages) =>
      sendMachineEventBatch(
        pool,
        messages.map((m) => ({
          workflowId: m.workflowId,
          event: { type: m.topic, ...m.message as object },
        })),
      ),
    getState: (workflowId) => getMachineState(pool, workflowId),
  };
}

export type PgGatewayContextOptions = Omit<GatewayContextOptions, "isShuttingDown">;

export async function createPgGatewayContext(
  config: GatewayConfig,
  pool: Pool,
  options: PgGatewayContextOptions,
): Promise<PgGatewayContext> {
  const client = createPgGatewayClient(pool);

  // Late-bound: startGateway sets ctx.cleanup, which backend.stop() invokes
  // during signal-driven shutdown to stop streams and close the checkpoint pool.
  // eslint-disable-next-line prefer-const
  let ctx: PgGatewayContext;

  const appContext = createAppContext({
    start: async () => {},
    stop: async () => { await ctx.cleanup?.(); },
  });

  const genericCtx = await createGatewayContext(config, client, {
    ...options,
    isShuttingDown: () => appContext.isShuttingDown(),
  });

  ctx = { ...genericCtx, pool, appContext };
  return ctx;
}

export function startPgGateway(ctx: PgGatewayContext): PgGatewayHandle {
  const handle = startGateway(ctx);

  // Wire signal handlers via AppContext
  void ctx.appContext.start({
    servers: [handle.server, ctx.adminServer],
    timeoutMs: ctx.config.shutdownTimeoutMs,
  });

  return handle;
}
