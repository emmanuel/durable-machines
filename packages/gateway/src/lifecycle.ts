import { z } from "zod";
import { serve } from "@hono/node-server";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import type { Hono } from "hono";
import type { Server } from "node:http";
import { createWebhookGateway } from "./gateway.js";
import { createRestApi } from "./rest-api.js";
import { createGatewayMetrics } from "./metrics.js";
import type { GatewayMetrics } from "./metrics.js";
import { createAdminServer } from "./admin.js";
import { gracefulShutdown, isShuttingDown } from "@durable-xstate/durable-machine/dbos";
import type { GatewayClient, WebhookBinding } from "./types.js";
import type { MachineRegistry } from "./rest-types.js";
import type { Logger, StreamBinding } from "./streams/types.js";
import type { StreamConsumerHandle } from "./streams/consumer.js";
import { startStreamConsumer } from "./streams/consumer.js";
import { pgCheckpointStore } from "./streams/checkpoint-store.js";

const gatewayConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  adminPort: z.coerce.number().int().positive().default(9090),
  dbUrl: z.string().url(),
  shutdownTimeoutMs: z.coerce.number().int().positive().default(30_000),
});

export interface GatewayConfig {
  port: number;
  adminPort: number;
  dbUrl: string;
  shutdownTimeoutMs: number;
}

export interface GatewayContext {
  config: GatewayConfig;
  client: GatewayClient;
  dbosClient: Awaited<ReturnType<typeof DBOSClient.create>>;
  metrics: GatewayMetrics;
  gateway: Hono;
  adminServer: Server;
  checkpointPool?: import("pg").Pool;
  streamConsumers?: StreamConsumerHandle[];
}

export interface GatewayHandle {
  shutdown(): Promise<void>;
  server: Server;
  adminServer: Server;
}

export function parseGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
  const result = gatewayConfigSchema.safeParse({
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

export interface GatewayContextOptions {
  bindings: WebhookBinding<any>[];
  /** Register durable machines to expose via the REST API with HATEOAS responses. */
  machines?: MachineRegistry;
  /** Base path prefix for REST API routes. @defaultValue `""` */
  restBasePath?: string;
  /** Enable URL-as-API shorthand routes for the REST API (single-machine mode). @defaultValue `false` */
  restShorthand?: boolean;
  streams?: Array<{
    binding: StreamBinding<any, any>;
    checkpointInterval?: number;
  }>;
  logger?: Logger;
}

export async function createGatewayContext(
  config: GatewayConfig,
  options: GatewayContextOptions,
): Promise<GatewayContext> {
  const dbosClient = await DBOSClient.create({ systemDatabaseUrl: config.dbUrl });
  const client: GatewayClient = {
    send: (workflowId, message, topic) => dbosClient.send(workflowId, message, topic),
    sendBatch: (messages) => Promise.all(
      messages.map((m) => dbosClient.send(m.workflowId, m.message, m.topic)),
    ).then(() => {}),
    getEvent: (workflowId, key, timeoutSeconds) => dbosClient.getEvent(workflowId, key, timeoutSeconds),
  };
  const metrics = createGatewayMetrics();
  const gateway = createWebhookGateway({ client, bindings: options.bindings, metrics });

  // Mount REST API if machines are registered
  if (options.machines && options.machines.size > 0) {
    const restApi = createRestApi({
      machines: options.machines,
      basePath: options.restBasePath,
      shorthand: options.restShorthand,
    });
    gateway.route("/", restApi);
  }

  const adminServer = createAdminServer({
    metrics,
    isReady: () => !isShuttingDown(),
  });

  const ctx: GatewayContext = { config, client, dbosClient, metrics, gateway, adminServer };

  if (options.streams && options.streams.length > 0) {
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: config.dbUrl,
      max: Math.max(2, options.streams.length + 1),
    });
    ctx.checkpointPool = pool;

    const checkpoints = pgCheckpointStore(pool);
    await checkpoints.ensureTable();

    const logger = options.logger ?? noopLogger;
    ctx.streamConsumers = options.streams.map((s) =>
      startStreamConsumer(s.binding, {
        client,
        checkpoints,
        logger,
        checkpointInterval: s.checkpointInterval,
        metrics,
      }),
    );
  }

  return ctx;
}

export function startGateway(ctx: GatewayContext): GatewayHandle {
  const server = serve({
    fetch: ctx.gateway.fetch,
    port: ctx.config.port,
  }) as unknown as Server;
  ctx.adminServer.listen(ctx.config.adminPort);

  const baseShutdown = gracefulShutdown({
    servers: [server, ctx.adminServer],
    timeoutMs: ctx.config.shutdownTimeoutMs,
  });

  const shutdown = async () => {
    // Stop stream consumers first (abort → final checkpoint → close)
    if (ctx.streamConsumers) {
      for (const handle of ctx.streamConsumers) {
        handle.stop();
      }
      await Promise.all(ctx.streamConsumers.map((h) => h.stopped));
    }

    // Shut down HTTP + admin servers
    await baseShutdown();

    // End checkpoint pool
    if (ctx.checkpointPool) {
      await ctx.checkpointPool.end();
    }
  };

  return {
    shutdown,
    server,
    adminServer: ctx.adminServer,
  };
}

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};
