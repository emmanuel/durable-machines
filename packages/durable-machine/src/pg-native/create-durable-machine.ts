import type { Pool } from "pg";
import type { AnyEventObject } from "xstate";
import type {
  DurableMachine,
  DurableMachineHandle,
  DurableMachineStatus,
  DurableStateSnapshot,
  EffectStatus,
  EventLogEntry,
  TransitionRecord,
} from "../types.js";
import { DurableMachineError } from "../types.js";
import type { MachineDefinition } from "../definition/types.js";
import { createStore } from "../pg/store.js";
import type { PgStore, MachineRow } from "../pg/store.js";
import { createTenantPool } from "../pg/tenant-pool.js";
import type {
  PgNativeDurableMachineOptions,
  NativeProcessResult,
  NativeCreateResult,
} from "./types.js";
import {
  Q_REGISTER_DEFINITION,
  Q_NATIVE_CREATE_INSTANCE,
  Q_NATIVE_PROCESS_EVENTS,
} from "./queries.js";
import { validateDefinition } from "../definition/validate-definition.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Extended durable machine interface for the PG-native backend. Exposes
 * internal processing methods and definition registration.
 */
export interface PgNativeDurableMachine extends DurableMachine {
  /** Register a machine definition in the machine_definitions table. */
  registerDefinition(definition: MachineDefinition): Promise<void>;
  /** Process queued events for an instance (called by listener fan-out and wake poller). */
  consumeAndProcess(instanceId: string): Promise<void>;
  /** Returns a tenant-scoped PgNativeDurableMachine backed by RLS. */
  forTenant(tenantId: string): PgNativeDurableMachine;
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

function parseProcessResult(row: any): NativeProcessResult {
  const r = row?.dm_process_events ?? row;
  const obj = typeof r === "string" ? JSON.parse(r) : r;
  return {
    processed: obj.processed ?? 0,
    status: obj.status ?? "running",
    invocation: obj.invocation ?? null,
  };
}

function parseCreateResult(row: any): NativeCreateResult {
  const r = row?.dm_create_instance ?? row;
  const obj = typeof r === "string" ? JSON.parse(r) : r;
  return {
    status: obj.status ?? "running",
    invocation: obj.invocation ?? null,
  };
}

// ─── Actor Execution Helper ─────────────────────────────────────────────────

function resolveActorCreator(
  impl: unknown,
): (params: { input: unknown }) => Promise<unknown> {
  if (typeof (impl as any)?.config === "function") return (impl as any).config;
  if (typeof impl === "function") return impl as any;
  throw new DurableMachineError(
    `Cannot resolve actor creator. Must be fromPromise() or async function. Got: ${typeof impl}`,
    "INTERNAL",
  );
}

// ─── Invocation Handler ─────────────────────────────────────────────────────

async function handleInvocation(
  store: PgStore,
  instanceId: string,
  invocation: { id: string; src: string; input: unknown },
  options: PgNativeDurableMachineOptions,
): Promise<void> {
  // 1. Check step_cache for cached result (crash recovery)
  const cached = await store.getStepCache(instanceId, invocation.id);
  if (cached) return; // Already processed; result event already in event_log

  // 2. Look up actor handler from registry
  const startedAt = Date.now();
  let output: unknown = null;
  let error: unknown = null;

  try {
    const impl = options.registry?.actors[invocation.src];
    if (!impl) {
      throw new DurableMachineError(
        `No actor implementation for "${invocation.src}". ` +
          `Provide it in the registry passed to createNativeDurableMachine().`,
        "INTERNAL",
      );
    }
    const actorFn = resolveActorCreator(impl);
    const timeoutMs = options.invokeTimeoutMs ?? 30_000;
    output = await Promise.race([
      actorFn({ input: invocation.input }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Actor "${invocation.src}" timed out after ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        ),
      ),
    ]);
  } catch (err) {
    error = err instanceof Error ? { message: err.message } : err;
  }

  const completedAt = Date.now();

  // 3. Record result
  await store.setStepCache({
    instanceId,
    stepKey: invocation.id,
    output,
    error,
    startedAt,
    completedAt,
  });

  // 4. Inject result event into event_log
  const eventType = error
    ? `xstate.error.actor.${invocation.id}`
    : `xstate.done.actor.${invocation.id}`;
  const payload = error
    ? { type: eventType, data: error }
    : { type: eventType, output };
  await store.appendEvent(instanceId, payload, "event", "system:invocation");
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createNativeDurableMachine(
  options: PgNativeDurableMachineOptions,
): PgNativeDurableMachine {
  const pool: Pool = options.pool;
  const store = options.store ?? createStore({ pool });

  // ── Definition Registration ──────────────────────────────────────────────

  async function registerDefinition(
    definition: MachineDefinition,
  ): Promise<void> {
    if (options.registry) {
      const result = validateDefinition(definition, options.registry);
      if (!result.valid) {
        throw new DurableMachineError(
          `Definition validation failed:\n${result.errors.join("\n")}`,
          "INTERNAL",
        );
      }
    }
    await pool.query({
      ...Q_REGISTER_DEFINITION,
      values: [options.machineName, JSON.stringify(definition)],
    });
  }

  // ── Event Consumer ───────────────────────────────────────────────────────

  const MAX_DRAIN_ROUNDS = 20;

  async function consumeAndProcess(instanceId: string): Promise<void> {
    for (let i = 0; i < MAX_DRAIN_ROUNDS; i++) {
      const { rows } = await pool.query({
        ...Q_NATIVE_PROCESS_EVENTS,
        values: [instanceId, 50],
      });
      const result = parseProcessResult(rows[0]);
      if (result.invocation) {
        await handleInvocation(store, instanceId, result.invocation, options);
        continue; // re-process after invocation result event is injected
      }
      if (result.processed === 0) return;
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
          await consumeAndProcess(workflowId);
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
            if (row.status === "done") return row.context;
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

        const maxWaitMs =
          options.maxWaitSeconds != null
            ? options.maxWaitSeconds * 1000
            : 30_000;
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new DurableMachineError(
                  `getResult() timed out after ${maxWaitMs}ms for instance ${workflowId}`,
                  "NOT_RUNNING",
                ),
              ),
            maxWaitMs,
          ),
        );
        return Promise.race([poll(), timeout]);
      },

      async cancel(): Promise<void> {
        await store.updateInstanceStatus(workflowId, "cancelled");
      },

      async getSteps() {
        return store.getInvokeSteps(workflowId);
      },

      async getTransitions(): Promise<TransitionRecord[]> {
        return store.getTransitions(workflowId);
      },

      async listEffects(): Promise<EffectStatus[]> {
        const rows = await store.listEffects(workflowId);
        return rows.map((r) => ({
          id: r.id,
          stateValue: r.stateValue,
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

      async getEventLog(
        opts?: { afterSeq?: number; limit?: number },
      ): Promise<EventLogEntry[]> {
        return store.getEventLog(workflowId, opts);
      },
    };
  }

  // ── PgNativeDurableMachine Interface ────────────────────────────────────

  return {
    machine: null as any,

    registerDefinition,

    async start(
      workflowId: string,
      input: Record<string, unknown>,
    ): Promise<DurableMachineHandle> {
      try {
        if (options.definition) {
          await registerDefinition(options.definition);
        }
        const { rows } = await pool.query({
          ...Q_NATIVE_CREATE_INSTANCE,
          values: [
            workflowId,
            options.machineName,
            JSON.stringify(input),
            null,
          ],
        });
        const result = parseCreateResult(rows[0]);
        if (result.invocation) {
          await handleInvocation(
            store,
            workflowId,
            result.invocation,
            options,
          );
          await consumeAndProcess(workflowId);
        }
      } catch (err: any) {
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
        machineName: options.machineName,
        ...filter,
      });
      return rows.map(rowToStatus);
    },

    async consumeAndProcess(instanceId: string): Promise<void> {
      await consumeAndProcess(instanceId);
    },

    forTenant(tenantId: string): PgNativeDurableMachine {
      const tenantPool = createTenantPool(options.pool, tenantId, "dm_tenant");
      return createNativeDurableMachine({
        ...options,
        pool: tenantPool,
        store: store.forTenant(tenantId),
      });
    },
  };
}
