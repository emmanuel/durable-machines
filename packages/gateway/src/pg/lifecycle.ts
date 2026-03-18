import type { Pool } from "pg";
import type { Server } from "node:http";
import type { Hono } from "hono";
import type { AnyEventObject } from "xstate";
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
} from "@durable-machines/machine/pg";
import { createAppContext } from "@durable-machines/machine";
import type { AppContext } from "@durable-machines/machine";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PgGatewayContext {
  readonly config: GatewayConfig;
  readonly client: GatewayClient;
  readonly pool: Pool;
  readonly metrics: GatewayMetrics;
  readonly gateway: Hono;
  readonly adminServer: Server;
}

/** @internal Full PG gateway context with internal lifecycle fields. */
interface InternalPgGatewayContext extends PgGatewayContext {
  appContext: AppContext;
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
    send: (workflowId, message, idempotencyKey) =>
      sendMachineEvent(pool, workflowId, message as AnyEventObject, idempotencyKey),
    sendBatch: (messages) =>
      sendMachineEventBatch(
        pool,
        messages.map((m) => ({
          workflowId: m.workflowId,
          event: m.message as AnyEventObject,
          idempotencyKey: m.idempotencyKey,
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
  let ctx: InternalPgGatewayContext;

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
  const internal = ctx as InternalPgGatewayContext;
  const handle = startGateway(internal);

  // Wire signal handlers via AppContext
  void internal.appContext.start({
    servers: [handle.server, ctx.adminServer],
    timeoutMs: ctx.config.shutdownTimeoutMs,
  });

  return handle;
}
