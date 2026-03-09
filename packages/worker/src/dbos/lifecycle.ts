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
import { createAppContext } from "@durable-xstate/durable-machine";
import type { AppContextBackend } from "@durable-xstate/durable-machine";
import type { WorkerAppContext } from "../types.js";
import {
  createWorkerContext,
  startWorker,
} from "../lifecycle.js";
import type { WorkerHandle } from "../lifecycle.js";

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

export interface DBOSWorkerContext {
  config: DBOSWorkerConfig;
  appContext: WorkerAppContext;
  machines: ReadonlyMap<string, DurableMachine>;
  metrics?: import("../metrics.js").WorkerMetrics;
  adminServer?: import("node:http").Server;
}

export type DBOSWorkerHandle = WorkerHandle;

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

export async function createDBOSWorkerContext<T extends MachineDefinitions>(
  config: DBOSWorkerConfig,
  options: { machines: T },
): Promise<DBOSWorkerContext> {
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
