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
import { processStartup, processEvent, processTimeout as processTimeoutInternal } from "./event-processor.js";
import type { EventProcessorOptions } from "./event-processor.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PgDurableMachineOptions extends DurableMachineOptions {
  pool: Pool;
  schema?: string;
  useListenNotify?: boolean;
  store?: PgStore;
}

/**
 * Extended durable machine interface for the PG backend. Exposes internal
 * processing methods used by the worker context's listener fan-out and
 * wake poller. The public `DurableMachine` type does not expose these.
 */
export interface PgDurableMachine<T extends AnyStateMachine = AnyStateMachine>
  extends DurableMachine<T>
{
  /** Process queued messages for an instance (called by listener fan-out). */
  consumeAndProcess(instanceId: string): Promise<void>;
  /** Process a timed-out instance (called by wake poller). */
  processTimeout(instanceId: string): Promise<void>;
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
): PgDurableMachine<T> {
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

  // ── PgDurableMachine Interface ────────────────────────────────────────────

  return {
    machine,

    async start(
      workflowId: string,
      input: Record<string, unknown>,
    ): Promise<DurableMachineHandle> {
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
      const rows = await store.listInstances({
        machineName: machine.id,
        ...filter,
      });
      return rows.map(rowToStatus);
    },

    async consumeAndProcess(instanceId: string): Promise<void> {
      await consumeAndProcessMessages(instanceId);
    },

    async processTimeout(instanceId: string): Promise<void> {
      await processTimeoutInternal(deps, instanceId);
    },
  };
}
