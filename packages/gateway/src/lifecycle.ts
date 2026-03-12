/**
 * Generic gateway lifecycle — backend-agnostic.
 *
 * Naming conventions:
 * - `*Config`   — env-derived configuration (Zod-validated)
 * - `*Options`  — programmer-supplied setup parameters
 * - `*Context`  — live runtime object (servers, clients, metrics)
 * - `*Handle`   — return value of start functions (has shutdown())
 *
 * Backend adapters: DBOS (acronym, all-caps) and Pg (abbreviation, title-case).
 */

import { z } from "zod";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import type { Server } from "node:http";
import { trimTrailingSlash } from "hono/trailing-slash";
import { createWebhookGateway } from "./gateway.js";
import { createRestApi } from "./rest-api.js";
import { createDashboard } from "./dashboard/index.js";
import { createGatewayMetrics } from "./metrics.js";
import type { GatewayMetrics } from "./metrics.js";
import { createAdminServer } from "./admin.js";
import type { GatewayClient, GatewaySecurityOptions, WebhookBinding } from "./types.js";
import type { MachineRegistry } from "./rest-types.js";
import type { Logger, StreamBinding } from "./streams/types.js";
import type { StreamConsumerHandle } from "./streams/consumer.js";
import { startStreamConsumer } from "./streams/consumer.js";
import { pgCheckpointStore } from "./streams/checkpoint-store.js";

const gatewayConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  adminPort: z.coerce.number().int().positive().default(9090),
  dbUrl: z.string().url().optional(),
  shutdownTimeoutMs: z.coerce.number().int().positive().default(30_000),
});

export interface GatewayConfig {
  port: number;
  adminPort: number;
  /** Database URL for stream checkpoints. Optional when streams are not used. */
  dbUrl?: string;
  shutdownTimeoutMs: number;
}

export interface GatewayContext {
  readonly config: GatewayConfig;
  readonly client: GatewayClient;
  readonly metrics: GatewayMetrics;
  readonly gateway: Hono;
  readonly adminServer: Server;
}

/** @internal Full context including internal fields used by lifecycle management. */
export interface InternalGatewayContext extends GatewayContext {
  checkpointPool?: import("pg").Pool;
  streamConsumers?: StreamConsumerHandle[];
  /** Resource cleanup set by {@link startGateway}. Called by AppContext `backend.stop()` in PG/DBOS adapters to stop streams and close the checkpoint pool during signal-driven shutdown. */
  cleanup?: () => Promise<void>;
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
    dbUrl: env.DATABASE_URL ?? env.DBOS_DATABASE_URL,
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

/** Minimal store interface for NOTIFY-driven dashboard SSE. */
export interface GatewayStoreAdapter {
  startListening(
    callback: (machineName: string, instanceId: string, topic: string) => void,
  ): Promise<void>;
  stopListening(): Promise<void>;
}

export interface GatewayContextOptions {
  bindings: WebhookBinding<any>[];
  /** Register durable machines to expose via the REST API with HATEOAS responses. */
  machines?: MachineRegistry;
  /** Base path prefix for REST API routes. @defaultValue `""` */
  restBasePath?: string;
  /** Mount the server-rendered dashboard at this path. Set to `false` to disable. @defaultValue `"/dashboard"` */
  dashboardPath?: string | false;
  /** Optional PgStore — enables NOTIFY-driven SSE for the dashboard instead of polling. */
  store?: GatewayStoreAdapter;
  streams?: Array<{
    binding: StreamBinding<any, any>;
    checkpointInterval?: number;
  }>;
  logger?: Logger;
  /** Returns `true` when the gateway is shutting down. Used for readiness probes. */
  isShuttingDown?: () => boolean;
  /** Pluggable auth middleware for REST API and dashboard routes. */
  security?: GatewaySecurityOptions;
  /** Maximum concurrent SSE connections for the dashboard. @defaultValue `100` */
  maxSseConnections?: number;
}

export async function createGatewayContext(
  config: GatewayConfig,
  client: GatewayClient,
  options: GatewayContextOptions,
): Promise<InternalGatewayContext> {
  const metrics = createGatewayMetrics();
  const gateway = createWebhookGateway({ client, bindings: options.bindings, metrics });
  gateway.use(trimTrailingSlash());

  // Mount REST API if machines are registered
  if (options.machines && options.machines.size > 0) {
    const restApi = createRestApi({
      machines: options.machines,
      basePath: options.restBasePath,
    });
    if (options.security?.restAuth) {
      restApi.use("*", options.security.restAuth);
    }
    gateway.route("/", restApi);

    // Mount dashboard unless explicitly disabled
    if (options.dashboardPath !== false) {
      const dashboardPath = options.dashboardPath || "/dashboard";
      const dashboard = createDashboard({
        machines: options.machines,
        basePath: dashboardPath,
        restBasePath: options.restBasePath,
        store: options.store,
        maxSseConnections: options.maxSseConnections,
      });
      if (options.security?.dashboardAuth) {
        dashboard.use("*", options.security.dashboardAuth);
      }
      gateway.route(dashboardPath, dashboard);
    }
  }

  const isShuttingDown = options.isShuttingDown ?? (() => false);
  const adminServer = createAdminServer({
    metricsHandler: metrics.metricsHandler,
    isReady: () => !isShuttingDown(),
  });

  const ctx: InternalGatewayContext = { config, client, metrics, gateway, adminServer };

  if (options.streams && options.streams.length > 0) {
    if (!config.dbUrl) {
      throw new Error("GatewayConfig.dbUrl is required when streams are configured");
    }
    const pgMod = await import("pg");
    const Pool = pgMod.default?.Pool ?? pgMod.Pool;
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

export function startGateway(ctx: InternalGatewayContext): GatewayHandle {
  const server = serve({
    fetch: ctx.gateway.fetch,
    port: ctx.config.port,
  }) as unknown as Server;
  ctx.adminServer.listen(ctx.config.adminPort);

  // Resource cleanup: stop streams + close checkpoint pool.
  // Exposed on ctx so AppContext backend.stop() can call it during signal shutdown.
  const cleanup = async () => {
    if (ctx.streamConsumers) {
      for (const handle of ctx.streamConsumers) {
        handle.stop();
      }
      await Promise.all(ctx.streamConsumers.map((h) => h.stopped));
    }
    if (ctx.checkpointPool) {
      await ctx.checkpointPool.end();
    }
  };
  ctx.cleanup = cleanup;

  // Standalone shutdown for direct callers (without AppContext signal handling)
  const shutdown = async () => {
    await cleanup();

    // Drain HTTP + admin servers
    const drainTimeout = ctx.config.shutdownTimeoutMs;
    const forceTimer = setTimeout(() => {
      server.closeAllConnections();
      ctx.adminServer.closeAllConnections();
    }, Math.floor(drainTimeout * 0.8));
    forceTimer.unref();

    await Promise.all([
      new Promise<void>((resolve) => {
        server.closeIdleConnections();
        server.close(() => resolve());
      }),
      new Promise<void>((resolve) => {
        ctx.adminServer.closeIdleConnections();
        ctx.adminServer.close(() => resolve());
      }),
    ]);
    clearTimeout(forceTimer);
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
