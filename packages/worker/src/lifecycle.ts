/**
 * Generic worker lifecycle — backend-agnostic.
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
import type { Server } from "node:http";
import type { AnyStateMachine } from "xstate";
import type { DurableMachine } from "@durable-xstate/durable-machine";
import type { WorkerAppContext } from "./types.js";
import { createAdminServer } from "./admin.js";
import { createWorkerMetrics, startTimer } from "./metrics.js";
import type { WorkerMetrics } from "./metrics.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkerConfig {
  adminPort?: number;
  shutdownTimeoutMs?: number;
}

export interface WorkerContext {
  config: WorkerConfig;
  appContext: WorkerAppContext;
  machines: ReadonlyMap<string, DurableMachine>;
  metrics?: WorkerMetrics;
  adminServer?: Server;
}

export interface WorkerHandle {
  shutdown(): Promise<void>;
  adminServer?: Server;
}

// ─── Config ─────────────────────────────────────────────────────────────────

const workerConfigSchema = z.object({
  adminPort: z.coerce.number().int().positive().optional(),
  shutdownTimeoutMs: z.coerce.number().int().positive().default(30_000),
});

export function parseWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
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

// ─── Factory ────────────────────────────────────────────────────────────────

export interface WorkerContextOptions {
  machines: Record<string, {
    machine: import("xstate").AnyStateMachine;
    options?: import("@durable-xstate/durable-machine").DurableMachineOptions;
  }>;
  /** Pre-created metrics. If omitted and adminPort is set, created automatically. */
  metrics?: WorkerMetrics;
}

export function createWorkerContext(
  config: WorkerConfig,
  appContext: WorkerAppContext,
  options: WorkerContextOptions,
): WorkerContext {
  let metrics: WorkerMetrics | undefined = options.metrics;
  if (!metrics && config.adminPort != null) {
    metrics = createWorkerMetrics();
  }

  const machines = new Map<string, DurableMachine>();
  for (const [key, def] of Object.entries(options.machines)) {
    const end = metrics ? startTimer(metrics.machineRegistrationDuration, { machine_id: key }) : undefined;
    const dm = appContext.register(def.machine, def.options);
    machines.set(key, dm);
    end?.();
  }

  let adminServer: Server | undefined;
  if (metrics) {
    adminServer = createAdminServer({
      metricsHandler: metrics.metricsHandler,
      isReady: () => !appContext.isShuttingDown(),
    });
  }

  return { config, appContext, machines, metrics, adminServer };
}

// ─── Start ──────────────────────────────────────────────────────────────────

export async function startWorker(ctx: WorkerContext): Promise<WorkerHandle> {
  const servers: Server[] = [];

  if (ctx.adminServer) {
    ctx.adminServer.listen(ctx.config.adminPort);
    servers.push(ctx.adminServer);
  }

  const end = ctx.metrics ? startTimer(ctx.metrics.backendStartDuration) : undefined;
  await ctx.appContext.start({
    servers,
    timeoutMs: ctx.config.shutdownTimeoutMs,
  });
  end?.();

  return {
    shutdown: () => ctx.appContext.shutdown("programmatic"),
    adminServer: ctx.adminServer,
  };
}

// ─── Typed machine accessor ─────────────────────────────────────────────────

/** Maps machine definition keys to typed {@link DurableMachine} handles. */
export type TypedMachines<T extends Record<string, { machine: AnyStateMachine }>> = {
  readonly [K in keyof T]: DurableMachine<T[K]["machine"]>;
};

/**
 * Type-safe wrapper over the machine Map. Property access delegates to
 * `map.get(key)` at runtime; TypeScript infers the correct DurableMachine
 * type from the definitions record.
 *
 * @example
 * ```ts
 * const definitions = {
 *   approvals: { machine: approvalMachine },
 *   orders: { machine: orderMachine },
 * } as const;
 *
 * const ctx = createWorkerContext(config, appContext, { machines: definitions });
 * const m = typedMachines<typeof definitions>(ctx.machines);
 * m.approvals.start("wf-1", {});  // fully typed
 * ```
 */
export function typedMachines<T extends Record<string, { machine: AnyStateMachine }>>(
  map: ReadonlyMap<string, DurableMachine>,
): TypedMachines<T> {
  return new Proxy({} as TypedMachines<T>, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return map.get(prop);
    },
  });
}
