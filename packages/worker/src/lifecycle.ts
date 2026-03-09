import { z } from "zod";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { AnyStateMachine } from "xstate";
import type { Server } from "node:http";
import {
  createDurableMachine,
  gracefulShutdown,
  isShuttingDown,
} from "@durable-xstate/durable-machine/dbos";
import type {
  DurableMachine,
  DurableMachineOptions,
} from "@durable-xstate/durable-machine";
import { createAdminServer } from "./admin.js";
import { createWorkerMetrics } from "./metrics.js";
import type { WorkerMetrics } from "./metrics.js";

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
