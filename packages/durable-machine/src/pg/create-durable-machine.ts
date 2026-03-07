import type { Pool } from "pg";
import type { AnyStateMachine, AnyEventObject } from "xstate";
import type {
  DurableMachine,
  DurableMachineHandle,
  DurableMachineOptions,
  DurableMachineStatus,
  DurableStateSnapshot,
} from "../types.js";
import { DurableMachineError } from "../types.js";
import { validateMachineForDurability } from "../validate.js";
import { createStore } from "./store.js";
import type { PgStore, MachineRow } from "./store.js";
import { processStartup, processEvent, processTimeout } from "./event-processor.js";
import type { EventProcessorOptions } from "./event-processor.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PgDurableMachineOptions extends DurableMachineOptions {
  pool: Pool;
  schema?: string;
  useListenNotify?: boolean;
  wakePollingIntervalMs?: number;
  store?: PgStore;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function rowToSnapshot(row: MachineRow): DurableStateSnapshot {
  return {
    value: row.stateValue,
    context: row.context,
    status: row.status === "done" ? "done" : row.status === "error" ? "error" : "running",
  };
}

function rowToStatus(row: MachineRow): DurableMachineStatus {
  return {
    workflowId: row.id,
    status: row.status,
    workflowName: row.machineName,
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createDurableMachine<T extends AnyStateMachine>(
  machine: T,
  options: PgDurableMachineOptions,
): DurableMachine<T> {
  // Validate at registration time
  validateMachineForDurability(machine);

  const store = options.store ?? createStore({
    pool: options.pool,
    schema: options.schema,
    useListenNotify: options.useListenNotify,
  });

  const deps: EventProcessorOptions = {
    store,
    machine,
    options,
    enableTransitionStream: options.enableTransitionStream ?? false,
  };

  const wakePollingIntervalMs = options.wakePollingIntervalMs ?? 5000;
  let wakePoller: ReturnType<typeof setInterval> | null = null;
  let initialized = false;

  // ── Lazy initialization ─────────────────────────────────────────────────

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    await store.ensureSchema();

    // Start LISTEN/NOTIFY for event-driven processing
    await store.startListening(async (instanceId, topic) => {
      if (topic !== "event") return;
      // When notified, consume the message and process it
      try {
        await consumeAndProcessMessages(instanceId);
      } catch {
        // Errors are retried on next notification or poll
      }
    });

    // Start timeout poller
    wakePoller = setInterval(() => {
      void pollTimeouts();
    }, wakePollingIntervalMs);
    // Don't hold the process open
    if (wakePoller.unref) wakePoller.unref();

    initialized = true;
  }

  // ── Message Consumer ────────────────────────────────────────────────────

  async function consumeAndProcessMessages(instanceId: string): Promise<void> {
    const client = await (store as any)._pool.connect();
    try {
      await client.query("BEGIN");
      const msg = await store.consumeNextMessage(client, instanceId);
      await client.query("COMMIT");

      if (msg) {
        await processEvent(deps, instanceId, msg.payload as AnyEventObject);
        // Process additional queued messages
        await consumeAndProcessMessages(instanceId);
      }
    } catch {
      await client.query("ROLLBACK").catch(() => {});
    } finally {
      client.release();
    }
  }

  // ── Timeout Poller ──────────────────────────────────────────────────────

  async function pollTimeouts(): Promise<void> {
    try {
      const pool = (store as any)._pool;
      const now = Date.now();
      const { rows } = await pool.query(
        `SELECT id FROM machine_instances
         WHERE wake_at <= $1 AND status = 'running' AND machine_name = $2
         ORDER BY wake_at ASC
         LIMIT 10`,
        [now, machine.id],
      );

      for (const row of rows) {
        try {
          await processTimeout(deps, row.id);
        } catch {
          // Individual timeout failures don't stop the poller
        }
      }
    } catch {
      // Poll errors are silently ignored — next poll will retry
    }
  }

  // ── Handle Factory ──────────────────────────────────────────────────────

  function makeHandle(workflowId: string): DurableMachineHandle {
    return {
      workflowId,

      async send(event: AnyEventObject): Promise<void> {
        await store.sendMessage(workflowId, event);
        // Also trigger immediate processing (don't wait for NOTIFY)
        try {
          await consumeAndProcessMessages(workflowId);
        } catch {
          // Will be retried via NOTIFY or polling
        }
      },

      async getState(): Promise<DurableStateSnapshot | null> {
        const row = await store.getInstance(workflowId);
        return row ? rowToSnapshot(row) : null;
      },

      async getResult(): Promise<Record<string, unknown>> {
        const poll = (): Promise<Record<string, unknown>> =>
          store.getInstance(workflowId).then((row) => {
            if (!row) {
              throw new DurableMachineError(
                `Instance ${workflowId} not found`,
              );
            }
            if (row.status === "done")
              return row.context;
            if (row.status === "error")
              throw new DurableMachineError(
                `Instance ${workflowId} errored`,
              );
            if (row.status === "cancelled")
              throw new DurableMachineError(
                `Instance ${workflowId} cancelled`,
              );
            return new Promise<void>((resolve) =>
              setTimeout(resolve, 200),
            ).then(poll);
          });
        return poll();
      },

      async getSteps() {
        return store.listInvokeResults(workflowId);
      },

      async cancel(): Promise<void> {
        await store.updateInstance(workflowId, { status: "cancelled" });
      },
    };
  }

  // ── DurableMachine Interface ────────────────────────────────────────────

  return {
    machine,

    async start(
      workflowId: string,
      input: Record<string, unknown>,
    ): Promise<DurableMachineHandle> {
      await ensureInitialized();
      try {
        await processStartup(deps, workflowId, input);
      } catch (err: any) {
        // Wrap unique constraint violations
        if (err?.code === "23505") {
          throw new DurableMachineError(
            `Instance ${workflowId} already exists`,
          );
        }
        throw err;
      }
      return makeHandle(workflowId);
    },

    get(workflowId: string): DurableMachineHandle {
      return makeHandle(workflowId);
    },

    async list(
      filter?: { status?: string },
    ): Promise<DurableMachineStatus[]> {
      await ensureInitialized();
      const rows = await store.listInstances({
        machineName: machine.id,
        ...filter,
      });
      return rows.map(rowToStatus);
    },
  };
}
