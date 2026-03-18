import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  createDurableMachine,
} from "@durable-machines/machine/dbos";
import type {
  DurableMachine,
} from "@durable-machines/machine";
import { createAppContext } from "@durable-machines/machine";
import type { AppContextBackend } from "@durable-machines/machine";
import type { WorkerAppContext } from "../types.js";
import {
  createWorkerContext,
  startWorker,
} from "../lifecycle.js";
import type {
  WorkerConfig,
  WorkerContextOptions,
  WorkerHandle,
} from "../lifecycle.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DBOSWorkerContext {
  config: WorkerConfig;
  appContext: WorkerAppContext;
  machines: ReadonlyMap<string, DurableMachine>;
  metrics?: import("../metrics.js").WorkerMetrics;
  adminServer?: import("node:http").Server;
}

export type DBOSWorkerHandle = WorkerHandle;

// ─── AppContext Factory ─────────────────────────────────────────────────────

export function createDBOSWorkerAppContext(): WorkerAppContext {
  const backend: AppContextBackend = {
    async start() { await DBOS.launch(); },
    async stop() { await DBOS.shutdown(); },
  };
  const appContext = createAppContext(backend);
  return {
    ...appContext,
    register(machine, options) {
      return createDurableMachine(machine, options);
    },
  };
}

// ─── Context + Start ────────────────────────────────────────────────────────

export function createDBOSWorkerContext(
  config: WorkerConfig,
  options: { machines: WorkerContextOptions["machines"] },
): DBOSWorkerContext {
  const appContext = createDBOSWorkerAppContext();
  const workerCtx = createWorkerContext(config, appContext, {
    machines: options.machines,
  });
  return {
    config,
    appContext,
    machines: workerCtx.machines,
    metrics: workerCtx.metrics,
    adminServer: workerCtx.adminServer,
  };
}

export async function startDBOSWorker(
  ctx: DBOSWorkerContext,
): Promise<DBOSWorkerHandle> {
  return startWorker(ctx);
}
