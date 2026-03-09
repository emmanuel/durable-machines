import type { Server } from "node:http";
import { z } from "zod";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { AnyStateMachine } from "xstate";
import {
  createDurableMachine,
} from "@durable-xstate/durable-machine/dbos";
import type {
  DurableMachine,
  DurableMachineOptions,
} from "@durable-xstate/durable-machine";
import { createAdminServer } from "../admin.js";
import { createWorkerMetrics } from "../metrics.js";
import type { WorkerMetrics } from "../metrics.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const workerConfigSchema = z.object({
  adminPort: z.coerce.number().int().positive().optional(),
  shutdownTimeoutMs: z.coerce.number().int().positive().default(30_000),
});

export interface DBOSWorkerConfig {
  adminPort?: number;
  shutdownTimeoutMs: number;
}

export type MachineDefinitions = Record<string, {
  machine: AnyStateMachine;
  options?: DurableMachineOptions;
}>;

export interface DBOSWorkerContext<T extends MachineDefinitions = MachineDefinitions> {
  config: DBOSWorkerConfig;
  machines: { [K in keyof T]: DurableMachine };
  adminServer?: Server;
}

export interface DBOSWorkerHandle {
  shutdown(): Promise<void>;
  adminServer?: Server;
}

export function parseDBOSWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): DBOSWorkerConfig {
  const result = workerConfigSchema.safeParse({
    adminPort: env.ADMIN_PORT,
    shutdownTimeoutMs: env.GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  });

  if (!result.success) {
    const messages = result.error.issues.map(
      (i) => `  ${i.path.join(".")}: ${i.message}`,
    );
    throw new Error(`Invalid worker config:\n${messages.join("\n")}`);
  }

  return result.data;
}

export async function createDBOSWorkerContext<T extends MachineDefinitions>(
  config: DBOSWorkerConfig,
  options: { machines: T },
): Promise<DBOSWorkerContext<T>> {
  // 1. Create metrics before any timed work
  let metrics: WorkerMetrics | undefined;
  if (config.adminPort != null) {
    metrics = createWorkerMetrics();
  }

  // 2. Create machines (timed per-machine)
  const machines = {} as { [K in keyof T]: DurableMachine };
  for (const [key, def] of Object.entries(options.machines)) {
    const end = metrics?.machineRegistrationDuration.startTimer({ machine_id: key });
    (machines as any)[key] = createDurableMachine(def.machine, def.options);
    end?.();
  }

  // 3. DBOS.launch (timed)
  const endLaunch = metrics?.launchDuration.startTimer();
  await DBOS.launch();
  endLaunch?.();

  // 4. Admin server
  let adminServer: Server | undefined;
  if (metrics) {
    adminServer = createAdminServer({
      metrics,
      isReady: () => !isShuttingDown(),
    });
  }

  return { config, machines, adminServer };
}

export function startDBOSWorker(ctx: DBOSWorkerContext): DBOSWorkerHandle {
  const servers: Server[] = [];

  if (ctx.adminServer) {
    ctx.adminServer.listen(ctx.config.adminPort);
    servers.push(ctx.adminServer);
  }

  const shutdown = gracefulShutdown({
    servers,
    timeoutMs: ctx.config.shutdownTimeoutMs,
  });

  return { shutdown, adminServer: ctx.adminServer };
}

// ─── Graceful Shutdown (DBOS-specific) ──────────────────────────────────────

export interface GracefulShutdownOptions {
  /** HTTP servers to close (e.g. Hono node server). Drained in order, first to last. */
  servers?: Server[];
  /**
   * Max ms to wait for drain before forcing exit. Default: `30_000`.
   * Overridden by `GRACEFUL_SHUTDOWN_TIMEOUT_MS` env var.
   */
  timeoutMs?: number;
  /** Signals to handle. Default: `["SIGTERM", "SIGINT"]`. */
  signals?: NodeJS.Signals[];
  /** Called when shutdown begins (for logging). */
  onShutdown?: (reason: string) => void;
  /** Handle uncaughtException/unhandledRejection. Default: `true`. */
  handleExceptions?: boolean;
}

let shuttingDown = false;

/**
 * Returns `true` if shutdown has been initiated. Use in readiness probes.
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

// Exported for testing — allows resetting module state between tests.
export function _resetShutdownState(): void {
  shuttingDown = false;
}

/**
 * Wire signal handlers for graceful process shutdown and return a shutdown
 * function for programmatic use.
 *
 * Shutdown sequence:
 * 1. Set `isShuttingDown` flag (readiness probes return 503)
 * 2. Call `onShutdown(reason)` callback
 * 3. For each server: `server.close()` + `server.closeIdleConnections()`;
 *    at 80% of timeout: `server.closeAllConnections()`
 * 4. `DBOS.shutdown()` — stop workflow processing, disconnect DB
 * 5. `process.exit(0)` on success
 * 6. Hard deadline: `setTimeout(timeoutMs)` → `process.exit(1)` backstop
 */
function gracefulShutdown(
  options: GracefulShutdownOptions = {},
): () => Promise<void> {
  const {
    servers = [],
    signals = ["SIGTERM", "SIGINT"],
    onShutdown,
    handleExceptions = true,
  } = options;

  const envTimeout = process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS;
  const timeoutMs = envTimeout ? Number(envTimeout) : (options.timeoutMs ?? 30_000);

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    onShutdown?.(reason);

    // Hard deadline backstop
    const backstop = setTimeout(() => {
      process.exit(1);
    }, timeoutMs);
    backstop.unref();

    // 80% drain timer — force-close remaining connections
    const drainDeadline = setTimeout(() => {
      for (const server of servers) {
        server.closeAllConnections();
      }
    }, Math.floor(timeoutMs * 0.8));
    drainDeadline.unref();

    // Close servers: stop accepting, drop idle connections
    const serverClosePromises = servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
        }),
    );
    await Promise.all(serverClosePromises);

    // Stop DBOS workflow processing
    await DBOS.shutdown();

    process.exit(0);
  }

  // Register signal handlers
  for (const signal of signals) {
    process.on(signal, () => {
      if (shuttingDown) {
        // Second signal — force exit immediately
        process.exit(1);
      }
      void shutdown(signal);
    });
  }

  // Exception handlers (opt-in, default true)
  if (handleExceptions) {
    process.on("uncaughtException", (err) => {
      void shutdown(`uncaughtException: ${err.message}`);
    });
    process.on("unhandledRejection", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      void shutdown(`unhandledRejection: ${message}`);
    });
  }

  return (reason?: string) => shutdown(reason ?? "programmatic");
}
