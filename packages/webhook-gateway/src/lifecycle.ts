import { z } from "zod";
import { serve } from "@hono/node-server";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import type { Hono } from "hono";
import type { Server } from "node:http";
import { createWebhookGateway } from "./gateway.js";
import { createGatewayMetrics } from "./metrics.js";
import type { GatewayMetrics } from "./metrics.js";
import { createAdminServer } from "./admin.js";
import { gracefulShutdown, isShuttingDown } from "@xstate-dbos/durable-state-machine";
import type { WebhookBinding } from "./types.js";

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
  client: Awaited<ReturnType<typeof DBOSClient.create>>;
  metrics: GatewayMetrics;
  gateway: Hono;
  adminServer: Server;
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

export async function createGatewayContext(
  config: GatewayConfig,
  options: { bindings: WebhookBinding<any>[] },
): Promise<GatewayContext> {
  const client = await DBOSClient.create({ systemDatabaseUrl: config.dbUrl });
  const metrics = createGatewayMetrics();
  const gateway = createWebhookGateway({ client, bindings: options.bindings, metrics });
  const adminServer = createAdminServer({
    metrics,
    isReady: () => !isShuttingDown(),
  });

  return { config, client, metrics, gateway, adminServer };
}

export function startGateway(ctx: GatewayContext): GatewayHandle {
  const server = serve({
    fetch: ctx.gateway.fetch,
    port: ctx.config.port,
  }) as unknown as Server;
  ctx.adminServer.listen(ctx.config.adminPort);

  const shutdown = gracefulShutdown({
    servers: [server, ctx.adminServer],
    timeoutMs: ctx.config.shutdownTimeoutMs,
  });

  return {
    shutdown,
    server,
    adminServer: ctx.adminServer,
  };
}
