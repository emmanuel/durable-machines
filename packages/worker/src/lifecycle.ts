import type { Server } from "node:http";
import type { DurableMachine } from "@durable-xstate/durable-machine";
import type { WorkerAppContext } from "./types.js";
import { createAdminServer } from "./admin.js";
import { createWorkerMetrics } from "./metrics.js";
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
  adminServer?: Server;
}

export interface WorkerHandle {
  shutdown(): Promise<void>;
  adminServer?: Server;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export interface WorkerContextOptions {
  machines: Record<string, {
    machine: import("xstate").AnyStateMachine;
    options?: import("@durable-xstate/durable-machine").DurableMachineOptions;
  }>;
}

export function createWorkerContext(
  config: WorkerConfig,
  appContext: WorkerAppContext,
  options: WorkerContextOptions,
): WorkerContext {
  let metrics: WorkerMetrics | undefined;
  if (config.adminPort != null) {
    metrics = createWorkerMetrics();
  }

  const machines = new Map<string, DurableMachine>();
  for (const [key, def] of Object.entries(options.machines)) {
    const end = metrics?.machineRegistrationDuration.startTimer({ machine_id: key });
    const dm = appContext.register(def.machine, def.options);
    machines.set(key, dm);
    end?.();
  }

  let adminServer: Server | undefined;
  if (metrics) {
    adminServer = createAdminServer({
      metrics,
      isReady: () => !appContext.isShuttingDown(),
    });
  }

  return { config, appContext, machines, adminServer };
}

// ─── Start ──────────────────────────────────────────────────────────────────

export async function startWorker(ctx: WorkerContext): Promise<WorkerHandle> {
  const servers: Server[] = [];

  if (ctx.adminServer) {
    ctx.adminServer.listen(ctx.config.adminPort);
    servers.push(ctx.adminServer);
  }

  await ctx.appContext.start({
    servers,
    timeoutMs: ctx.config.shutdownTimeoutMs,
  });

  return {
    shutdown: () => ctx.appContext.shutdown("programmatic"),
    adminServer: ctx.adminServer,
  };
}
