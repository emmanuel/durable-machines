import { z } from "zod";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import type { Server } from "node:http";
import type { Hono } from "hono";
import type { GatewayMetrics } from "../metrics.js";
import {
  createGatewayContext,
  startGateway,
} from "../lifecycle.js";
import type {
  GatewayContextOptions,
} from "../lifecycle.js";
import type { GatewayClient } from "../types.js";
import type { StreamConsumerHandle } from "../streams/consumer.js";
import { createAppContext } from "@durable-xstate/durable-machine";
import type { AppContext } from "@durable-xstate/durable-machine";

// ─── Config ─────────────────────────────────────────────────────────────────

const dbosGatewayConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  adminPort: z.coerce.number().int().positive().default(9090),
  dbUrl: z.string().url(),
  shutdownTimeoutMs: z.coerce.number().int().positive().default(30_000),
});

export interface DBOSGatewayConfig {
  port: number;
  adminPort: number;
  dbUrl: string;
  shutdownTimeoutMs: number;
}

export interface DBOSGatewayContext {
  readonly config: DBOSGatewayConfig;
  readonly client: GatewayClient;
  readonly metrics: GatewayMetrics;
  readonly gateway: Hono;
  readonly adminServer: Server;
}

/** @internal Full DBOS gateway context with internal lifecycle fields. */
interface InternalDBOSGatewayContext extends DBOSGatewayContext {
  dbosClient: Awaited<ReturnType<typeof DBOSClient.create>>;
  appContext: AppContext;
  checkpointPool?: import("pg").Pool;
  streamConsumers?: StreamConsumerHandle[];
  cleanup?: () => Promise<void>;
}

export interface DBOSGatewayHandle {
  shutdown(): Promise<void>;
  server: Server;
  adminServer: Server;
}

export function parseDBOSGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): DBOSGatewayConfig {
  const result = dbosGatewayConfigSchema.safeParse({
    port: env.PORT,
    adminPort: env.ADMIN_PORT,
    dbUrl: env.DBOS_DATABASE_URL,
    shutdownTimeoutMs: env.GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  });

  if (!result.success) {
    const messages = result.error.issues.map(
      (i) => `  ${i.path.join(".")}: ${i.message}`,
    );
    throw new Error(`Invalid gateway config:\n${messages.join("\n")}`);
  }

  return result.data;
}

export type DBOSGatewayContextOptions = Omit<GatewayContextOptions, "isShuttingDown">;

export async function createDBOSGatewayContext(
  config: DBOSGatewayConfig,
  options: DBOSGatewayContextOptions,
): Promise<DBOSGatewayContext> {
  const dbosClient = await DBOSClient.create({ systemDatabaseUrl: config.dbUrl });
  const client: GatewayClient = {
    send: (workflowId, message) => dbosClient.send(workflowId, message, "xstate.event"),
    sendBatch: (messages) => Promise.all(
      messages.map((m) => dbosClient.send(m.workflowId, m.message, "xstate.event")),
    ).then(() => {}),
    getState: (workflowId) => dbosClient.getEvent(workflowId, "xstate.state", 0.1),
  };

  // Late-bound: startGateway sets ctx.cleanup, which backend.stop() invokes
  // during signal-driven shutdown to stop streams and close the checkpoint pool.
  // eslint-disable-next-line prefer-const
  let ctx: InternalDBOSGatewayContext;

  const appContext = createAppContext({
    start: async () => {},
    stop: async () => { await ctx.cleanup?.(); },
  });

  const genericCtx = await createGatewayContext(config, client, {
    ...options,
    isShuttingDown: () => appContext.isShuttingDown(),
  });

  ctx = { ...genericCtx, config, dbosClient, appContext };
  return ctx;
}

export function startDBOSGateway(ctx: DBOSGatewayContext): DBOSGatewayHandle {
  const internal = ctx as InternalDBOSGatewayContext;
  const handle = startGateway(internal);

  // Wire signal handlers via AppContext
  void internal.appContext.start({
    servers: [handle.server, ctx.adminServer],
    timeoutMs: ctx.config.shutdownTimeoutMs,
  });

  return handle;
}
