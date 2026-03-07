import { Pool } from "pg";
import type { Pool as PoolType } from "pg";
import type { AnyStateMachine } from "xstate";
import type {
  WorkerAppContext,
  DurableMachine,
  DurableMachineOptions,
} from "../types.js";
import { createAppContext } from "../app-context.js";
import { createStore } from "./store.js";
import type { PgStore } from "./store.js";
import { createDurableMachine } from "./create-durable-machine.js";
import type { PgDurableMachine } from "./create-durable-machine.js";
import type { PgConfig } from "./config.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PgWorkerAppContext = WorkerAppContext & {
  readonly pool: PoolType;
  readonly store: PgStore;
};

// ─── Factory ────────────────────────────────────────────────────────────────

export function createPgWorkerContext(config: PgConfig): PgWorkerAppContext {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const store = createStore({
    pool,
    schema: config.schema,
    useListenNotify: config.useListenNotify,
  });

  const machines = new Map<string, PgDurableMachine>();
  let pollerHandle: ReturnType<typeof setInterval> | null = null;

  // ── Poll for timed-out instances ────────────────────────────────────────

  async function pollTimeouts(): Promise<void> {
    try {
      const now = Date.now();
      const { rows } = await pool.query(
        `SELECT id, machine_name FROM machine_instances
         WHERE wake_at <= $1 AND status = 'running' LIMIT 50`,
        [now],
      );

      for (const row of rows) {
        const dm = machines.get(row.machine_name);
        if (!dm) continue;
        try {
          await dm.processTimeout(row.id);
        } catch {
          // Individual failures don't stop the poller
        }
      }
    } catch {
      // Query failures don't stop the poller
    }
  }

  // ── Backend for createAppContext ────────────────────────────────────────

  const backend = {
    async start(): Promise<void> {
      await store.ensureSchema();

      await store.startListening(
        (machineName: string, instanceId: string, topic: string) => {
          if (topic !== "event") return;
          const dm = machines.get(machineName);
          if (!dm) return;
          void dm.consumeAndProcess(instanceId);
        },
      );

      const intervalMs = config.wakePollingIntervalMs ?? 5000;
      pollerHandle = setInterval(() => {
        void pollTimeouts();
      }, intervalMs);
      pollerHandle.unref();
    },

    async stop(): Promise<void> {
      if (pollerHandle != null) {
        clearInterval(pollerHandle);
        pollerHandle = null;
      }
      await store.close();
      await pool.end();
    },
  };

  const appContext = createAppContext(backend);

  // ── Register ───────────────────────────────────────────────────────────

  function register<T extends AnyStateMachine>(
    machine: T,
    options?: DurableMachineOptions,
  ): DurableMachine<T> {
    if (machines.has(machine.id)) {
      throw new Error(`Machine "${machine.id}" is already registered`);
    }

    const dm = createDurableMachine(machine, {
      pool,
      store,
      ...options,
    });

    machines.set(machine.id, dm);

    // Return as DurableMachine (hides PgDurableMachine internals)
    return dm as DurableMachine<T>;
  }

  return {
    start: appContext.start,
    shutdown: appContext.shutdown,
    isShuttingDown: appContext.isShuttingDown,
    register,
    pool,
    store,
  };
}
