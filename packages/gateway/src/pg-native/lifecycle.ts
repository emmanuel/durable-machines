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
import { Q_SEND_EVENT } from "@durable-machines/machine/pg-native";
import { getMachineState } from "@durable-machines/machine/pg";
import { createAppContext } from "@durable-machines/machine";
import type { AppContext } from "@durable-machines/machine";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PgNativeGatewayContext {
  readonly config: GatewayConfig;
  readonly client: GatewayClient;
  readonly pool: Pool;
  readonly metrics: GatewayMetrics;
  readonly gateway: Hono;
  readonly adminServer: Server;
}

/** @internal Full PG-native gateway context with internal lifecycle fields. */
interface InternalPgNativeGatewayContext extends PgNativeGatewayContext {
  appContext: AppContext;
  checkpointPool?: import("pg").Pool;
  streamConsumers?: import("../streams/consumer.js").StreamConsumerHandle[];
  cleanup?: () => Promise<void>;
}

export interface PgNativeGatewayHandle {
  shutdown(): Promise<void>;
  server: Server;
  adminServer: Server;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createPgNativeGatewayClient(pool: Pool): GatewayClient {
  return {
    send: async (workflowId, message, idempotencyKey) => {
      const event = message as AnyEventObject;
      await pool.query({
        ...Q_SEND_EVENT,
        values: [workflowId, event.type, JSON.stringify(event), idempotencyKey ?? null],
      });
    },
    sendBatch: async (messages) => {
      for (const m of messages) {
        const event = m.message as AnyEventObject;
        await pool.query({
          ...Q_SEND_EVENT,
          values: [m.workflowId, event.type, JSON.stringify(event), m.idempotencyKey ?? null],
        });
      }
    },
    getState: (workflowId) => getMachineState(pool, workflowId),
  };
}

export type PgNativeGatewayContextOptions = Omit<GatewayContextOptions, "isShuttingDown">;

export async function createPgNativeGatewayContext(
  config: GatewayConfig,
  pool: Pool,
  options: PgNativeGatewayContextOptions,
): Promise<PgNativeGatewayContext> {
  const client = createPgNativeGatewayClient(pool);

  // Late-bound: startPgNativeGateway sets ctx.cleanup, which backend.stop()
  // invokes during signal-driven shutdown to stop streams and close the
  // checkpoint pool.
  // eslint-disable-next-line prefer-const
  let ctx: InternalPgNativeGatewayContext;

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

export function startPgNativeGateway(ctx: PgNativeGatewayContext): PgNativeGatewayHandle {
  const internal = ctx as InternalPgNativeGatewayContext;
  const handle = startGateway(internal);

  // Wire signal handlers via AppContext
  void internal.appContext.start({
    servers: [handle.server, ctx.adminServer],
    timeoutMs: ctx.config.shutdownTimeoutMs,
  });

  return handle;
}
