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
  config: DBOSGatewayConfig;
  client: GatewayClient;
  dbosClient: Awaited<ReturnType<typeof DBOSClient.create>>;
  appContext: AppContext;
  metrics: GatewayMetrics;
  gateway: Hono;
  adminServer: Server;
  checkpointPool?: import("pg").Pool;
  streamConsumers?: StreamConsumerHandle[];
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
    send: (workflowId, message, topic) => dbosClient.send(workflowId, message, topic),
    sendBatch: (messages) => Promise.all(
      messages.map((m) => dbosClient.send(m.workflowId, m.message, m.topic)),
    ).then(() => {}),
    getEvent: (workflowId, key, timeoutSeconds) => dbosClient.getEvent(workflowId, key, timeoutSeconds),
  };

  // Gateway doesn't launch DBOS runtime — use generic AppContext with a no-op backend
  const appContext = createAppContext({ start: async () => {}, stop: async () => {} });

  const genericCtx = await createGatewayContext(config, client, {
    ...options,
    isShuttingDown: () => appContext.isShuttingDown(),
  });

  return {
    ...genericCtx,
    config,
    dbosClient,
    appContext,
  };
}

export function startDBOSGateway(ctx: DBOSGatewayContext): DBOSGatewayHandle {
  const handle = startGateway(ctx);

  // Wire signal handlers via AppContext
  void ctx.appContext.start({
    servers: [handle.server, ctx.adminServer],
    timeoutMs: ctx.config.shutdownTimeoutMs,
  });

  return handle;
}
