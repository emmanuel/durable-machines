import type { Pool } from "pg";
import type { AnyStateMachine, AnyEventObject } from "xstate";
import type {
  DurableMachine,
  DurableMachineHandle,
  DurableMachineOptions,
  DurableMachineStatus,
  DurableStateSnapshot,
  EffectStatus,
  EventLogEntry,
  TransitionRecord,
} from "../types.js";
import { DurableMachineError } from "../types.js";
import { validateMachineForDurability } from "../validate.js";
import { createStore } from "./store.js";
import type { PgStore, MachineRow } from "./store.js";
import { createStoreInstruments } from "./store-metrics.js";
import { processStartup, processBatchFromLog } from "./event-processor.js";
import type { EventProcessorOptions } from "./event-processor.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PgDurableMachineOptions extends DurableMachineOptions {
  pool: Pool;
  schema?: string;
  useListenNotify?: boolean;
  store?: PgStore;
  useBatchProcessing?: boolean;
}

/**
 * Extended durable machine interface for the PG backend. Exposes internal
 * processing methods used by the worker context's listener fan-out and
 * wake poller. The public `DurableMachine` type does not expose these.
 */
export interface PgDurableMachine<T extends AnyStateMachine = AnyStateMachine>
  extends DurableMachine<T>
{
  /** Process queued events for an instance (called by listener fan-out and wake poller). */
  consumeAndProcess(instanceId: string): Promise<void>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function rowToSnapshot(row: MachineRow): DurableStateSnapshot {
  return {
    value: row.stateValue,
    context: row.context,
    status: row.status,
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
  validateMachineForDurability(machine, { effectHandlers: options.effectHandlers });

  const instruments = createStoreInstruments(options.pool);
  const store = options.store ?? createStore({
    pool: options.pool,
    schema: options.schema,
    useListenNotify: options.useListenNotify,
    instruments,
  });

  const deps: EventProcessorOptions = {
    store,
    machine,
    options,
    enableAnalytics: options.enableAnalytics ?? false,
    instruments,
  };

  // ── Event Consumer ──────────────────────────────────────────────────────

  const useBatch = options.useBatchProcessing !== false;

  const MAX_DRAIN_ROUNDS = 20;

  async function consumeAndProcessMessages(instanceId: string): Promise<void> {
    for (let i = 0; i < MAX_DRAIN_ROUNDS; i++) {
      const count = await processBatchFromLog(deps, instanceId, useBatch ? undefined : 1);
      if (count === 0) return;
    }
    // Remaining events will be picked up by next NOTIFY or poll cycle
  }

  // ── Handle Factory ──────────────────────────────────────────────────────

  function makeHandle(workflowId: string): DurableMachineHandle {
    return {
      workflowId,

      async send(event: AnyEventObject): Promise<void> {
        await store.appendEvent(workflowId, event);
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
                "NOT_FOUND",
              );
            }
            if (row.status === "done")
              return row.context;
            if (row.status === "error")
              throw new DurableMachineError(
                `Instance ${workflowId} errored`,
                "ERRORED",
              );
            if (row.status === "cancelled")
              throw new DurableMachineError(
                `Instance ${workflowId} cancelled`,
                "CANCELLED",
              );
            return new Promise<void>((resolve) =>
              setTimeout(resolve, 200),
            ).then(poll);
          });

        const maxWaitMs = options.maxWaitSeconds != null
          ? options.maxWaitSeconds * 1000
          : 30_000;
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new DurableMachineError(
              `getResult() timed out after ${maxWaitMs}ms for instance ${workflowId}`,
              "NOT_RUNNING",
            )),
            maxWaitMs,
          ),
        );
        return Promise.race([poll(), timeout]);
      },

      async getSteps() {
        return store.listInvokeResults(workflowId);
      },

      async cancel(): Promise<void> {
        await store.updateInstanceStatus(workflowId, "cancelled");
      },

      async listEffects(): Promise<EffectStatus[]> {
        const rows = await store.listEffects(workflowId);
        return rows.map((r) => ({
          id: r.id,
          effectType: r.effectType,
          effectPayload: r.effectPayload,
          status: r.status,
          attempts: r.attempts,
          maxAttempts: r.maxAttempts,
          lastError: r.lastError,
          createdAt: r.createdAt,
          completedAt: r.completedAt,
        }));
      },

      async getTransitions(): Promise<TransitionRecord[]> {
        return store.getTransitions(workflowId);
      },

      async getEventLog(opts?: { afterSeq?: number; limit?: number }): Promise<EventLogEntry[]> {
        return store.getEventLog(workflowId, opts);
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
            "ALREADY_EXISTS",
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

    getAnalytics: options.enableAnalytics
      ? () => ({
          getStateDurations: (instanceId: string) => store.getStateDurations(instanceId),
          getAggregateStateDurations: () => store.getAggregateStateDurations(machine.id),
          getTransitionCounts: () => store.getTransitionCounts(machine.id),
          getInstanceSummaries: () => store.getInstanceSummaries(machine.id),
        })
      : undefined,

    async consumeAndProcess(instanceId: string): Promise<void> {
      await consumeAndProcessMessages(instanceId);
    },
  };
}
