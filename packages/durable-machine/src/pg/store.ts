import type { PoolClient } from "pg";
import type { StateValue } from "xstate";
import type { StepInfo, TransitionRecord, InstanceStatus, EffectOutboxStatus } from "../types.js";
import { SCHEMA_SQL } from "./schema.js";
import { ROLES_SQL, RLS_SQL } from "./roles-sql.js";
import { createTenantPool } from "./tenant-pool.js";
import { createListenNotify } from "./listen-notify.js";
import {
  Q_CREATE_INSTANCE, Q_GET_INSTANCE, Q_UPDATE_INSTANCE_STATUS,
  Q_UPDATE_INSTANCE_SNAPSHOT, Q_LOCK_AND_GET_INSTANCE,
  Q_APPEND_EVENT, Q_LOCK_AND_PEEK_EVENT, Q_LOCK_AND_PEEK_EVENTS,
  Q_GET_STEP_CACHE, Q_SET_STEP_CACHE,
  Q_FINALIZE_INSTANCE, Q_FINALIZE_WITH_TRANSITION,
  Q_APPEND_TRANSITION, Q_GET_TRANSITIONS,
  Q_CLAIM_PENDING_TASKS, Q_MARK_EFFECT_COMPLETED, Q_MARK_EFFECT_FAILED,
  Q_LIST_EFFECTS, Q_RESET_STALE_EFFECTS,
  Q_INSERT_EFFECTS,
  Q_INSERT_INVOKE_TASK, Q_CHECK_INVOKE_EVENT_EXISTS,
  Q_CANCEL_INVOKE_TASK, Q_CANCEL_INSTANCE_INVOKES,
  Q_CHECK_TASK_STATUS, Q_APPEND_EVENT_WITH_KEY,
  Q_GET_INVOKE_STEPS,
  Q_STATE_DURATIONS,
  Q_AGGREGATE_STATE_DURATIONS,
  Q_TRANSITION_COUNTS,
  Q_INSTANCE_SUMMARIES,
} from "./queries.js";
import { DurableMachineError } from "../types.js";
import {
  rowToMachine, rowToEffect, rowToTask, rowToEventLog,
  pickListQuery, pickEventLogQuery,
} from "./store-types.js";
import type {
  PgStoreOptions, MachineRow, PgStore,
  CreateInstanceParams, FinalizeParams, TransitionData,
  SetStepCacheParams, QueueInvokeTaskParams, InsertEffectsParams,
  EventLogEntry, EffectOutboxRow, TaskOutboxRow,
  StateDurationRow, AggregateStateDuration, TransitionCountRow, InstanceSummaryRow,
} from "./store-types.js";

export type {
  PgStoreOptions, MachineRow, EventLogEntry, EffectOutboxRow, TaskOutboxRow,
  CreateInstanceParams, FinalizeParams, TransitionData,
  SetStepCacheParams, QueueInvokeTaskParams, InsertEffectsParams, PgStore,
  StateDurationRow, AggregateStateDuration, TransitionCountRow, InstanceSummaryRow,
} from "./store-types.js";

// ─── Factory ────────────────────────────────────────────────────────────────

export function createStore(options: PgStoreOptions): PgStore {
  const { pool, useListenNotify = true, instruments: instr } = options;

  // Query timing helpers — zero overhead when instruments not provided
  function qStart(): number { return instr ? performance.now() : 0; }
  function qEnd(name: string, start: number): void {
    if (instr) instr.queryDuration.record(performance.now() - start, { query: name });
  }

  // ── Transaction management ──────────────────────────────────────────────

  async function connect(): Promise<PoolClient> {
    if (!instr) return pool.connect();
    const start = performance.now();
    const client = await pool.connect();
    instr.poolCheckoutDuration.record(performance.now() - start);
    return client;
  }

  async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Schema ──────────────────────────────────────────────────────────────

  async function ensureSchema(): Promise<void> {
    await pool.query(SCHEMA_SQL);
  }

  async function ensureRoles(): Promise<void> {
    await pool.query(ROLES_SQL);
    await pool.query(RLS_SQL);
  }

  // ── Instance CRUD ───────────────────────────────────────────────────────

  async function createInstance(params: CreateInstanceParams): Promise<void> {
    const { id, machineName, stateValue, context, input, wakeAt, firedDelays, queryable, wakeEvent } = params;
    const q = queryable ?? pool;
    const t = qStart();
    const now = Date.now();
    await q.query({
      ...Q_CREATE_INSTANCE,
      values: [
        id,
        machineName,
        JSON.stringify(stateValue),
        JSON.stringify(context),
        JSON.stringify(firedDelays ?? []),
        wakeAt ?? null,
        wakeEvent != null ? JSON.stringify(wakeEvent) : null,
        input != null ? JSON.stringify(input) : null,
        now,
        now,
      ],
    });
    qEnd(Q_CREATE_INSTANCE.name, t);
  }

  async function getInstance(id: string): Promise<MachineRow | null> {
    const t = qStart();
    const { rows } = await pool.query({ ...Q_GET_INSTANCE, values: [id] });
    qEnd(Q_GET_INSTANCE.name, t);
    return rows.length > 0 ? rowToMachine(rows[0]) : null;
  }

  async function updateInstanceStatus(
    id: string,
    status: InstanceStatus,
  ): Promise<void> {
    const t = qStart();
    await pool.query({ ...Q_UPDATE_INSTANCE_STATUS, values: [id, status, Date.now()] });
    qEnd(Q_UPDATE_INSTANCE_STATUS.name, t);
  }

  async function updateInstanceSnapshot(
    client: PoolClient,
    id: string,
    stateValue: StateValue,
    context: Record<string, unknown>,
  ): Promise<void> {
    const t = qStart();
    await client.query({
      ...Q_UPDATE_INSTANCE_SNAPSHOT,
      values: [id, JSON.stringify(stateValue), JSON.stringify(context), Date.now()],
    });
    qEnd(Q_UPDATE_INSTANCE_SNAPSHOT.name, t);
  }

  async function listInstances(filter?: {
    machineName?: string;
    status?: string;
  }): Promise<MachineRow[]> {
    const t = qStart();
    const [q, v] = pickListQuery(filter?.machineName, filter?.status);
    const result = await pool.query({ ...q, values: v });
    qEnd("dm_list_instances", t);
    return result.rows.map(rowToMachine);
  }

  // ── Locking ─────────────────────────────────────────────────────────────

  async function lockAndGetInstance(
    client: PoolClient,
    id: string,
  ): Promise<MachineRow | null> {
    const t = qStart();
    const { rows } = await client.query({ ...Q_LOCK_AND_GET_INSTANCE, values: [id] });
    qEnd(Q_LOCK_AND_GET_INSTANCE.name, t);
    return rows.length > 0 ? rowToMachine(rows[0]) : null;
  }

  // ── Event Log ───────────────────────────────────────────────────────────

  /** Maximum event payload size: 256 KB. */
  const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;

  async function appendEvent(
    instanceId: string,
    payload: unknown,
    topic = "event",
    source?: string,
  ): Promise<{ seq: number }> {
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, "utf-8") > MAX_EVENT_PAYLOAD_BYTES) {
      throw new DurableMachineError("Event payload exceeds 256 KB size limit", "INTERNAL");
    }
    const t = qStart();
    const { rows } = await pool.query({
      ...Q_APPEND_EVENT,
      values: [instanceId, topic, json, source ?? null, null, Date.now()],
    });
    qEnd(Q_APPEND_EVENT.name, t);
    return { seq: Number(rows[0].seq) };
  }

  async function lockAndPeekEvent(
    client: PoolClient,
    instanceId: string,
  ): Promise<{
    row: MachineRow;
    nextEvent: { seq: number; payload: unknown } | null;
  } | null> {
    const t = qStart();
    const { rows } = await client.query({ ...Q_LOCK_AND_PEEK_EVENT, values: [instanceId] });
    qEnd(Q_LOCK_AND_PEEK_EVENT.name, t);
    if (rows.length === 0) return null;
    const r = rows[0];
    const machineRow = rowToMachine(r);
    const nextEvent = r.evt_seq != null
      ? { seq: Number(r.evt_seq), payload: r.evt_payload }
      : null;
    return { row: machineRow, nextEvent };
  }

  async function lockAndPeekEvents(
    client: PoolClient,
    instanceId: string,
    limit: number,
  ): Promise<{
    row: MachineRow;
    events: Array<{ seq: number; payload: unknown }>;
  } | null> {
    const t = qStart();
    const { rows } = await client.query({ ...Q_LOCK_AND_PEEK_EVENTS, values: [instanceId, limit] });
    qEnd(Q_LOCK_AND_PEEK_EVENTS.name, t);
    if (rows.length === 0) return null;
    const machineRow = rowToMachine(rows[0]);
    const events: Array<{ seq: number; payload: unknown }> = [];
    for (const r of rows) {
      if (r.evt_seq != null) {
        events.push({ seq: Number(r.evt_seq), payload: r.evt_payload });
      }
    }
    return { row: machineRow, events };
  }

  async function getEventLog(
    instanceId: string,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<EventLogEntry[]> {
    const t = qStart();
    const [q, v] = pickEventLogQuery(instanceId, opts?.afterSeq, opts?.limit);
    const result = await pool.query({ ...q, values: v });
    qEnd("dm_get_event_log", t);
    return result.rows.map(rowToEventLog);
  }

  // ── Task Queue (Invoke + Effect) ─────────────────────────────────────────

  async function queueInvokeTask(params: QueueInvokeTaskParams): Promise<void> {
    const { client, instanceId, machineName, invokeId, invokeSrc, invokeInput, stateValue, maxAttempts = 3 } = params;
    const t = qStart();
    await client.query({
      ...Q_INSERT_INVOKE_TASK,
      values: [
        instanceId,
        JSON.stringify(stateValue),
        maxAttempts,
        Date.now(),
        machineName,
        invokeId,
        invokeSrc,
        invokeInput != null ? JSON.stringify(invokeInput) : null,
      ],
    });
    qEnd(Q_INSERT_INVOKE_TASK.name, t);
  }

  async function checkInvokeEventExists(instanceId: string, idempotencyKey: string): Promise<boolean> {
    const t = qStart();
    const { rows } = await pool.query({ ...Q_CHECK_INVOKE_EVENT_EXISTS, values: [instanceId, idempotencyKey] });
    qEnd(Q_CHECK_INVOKE_EVENT_EXISTS.name, t);
    return rows.length > 0;
  }

  async function cancelInvokeTask(client: import("pg").PoolClient, instanceId: string, invokeId: string): Promise<void> {
    const t = qStart();
    await client.query({ ...Q_CANCEL_INVOKE_TASK, values: [instanceId, invokeId, Date.now()] });
    qEnd(Q_CANCEL_INVOKE_TASK.name, t);
  }

  async function cancelInstanceInvokes(instanceId: string): Promise<void> {
    const t = qStart();
    await pool.query({ ...Q_CANCEL_INSTANCE_INVOKES, values: [instanceId, Date.now()] });
    qEnd(Q_CANCEL_INSTANCE_INVOKES.name, t);
  }

  async function checkTaskStatus(taskId: string): Promise<EffectOutboxStatus | null> {
    const t = qStart();
    const { rows } = await pool.query({ ...Q_CHECK_TASK_STATUS, values: [taskId] });
    qEnd(Q_CHECK_TASK_STATUS.name, t);
    return rows.length > 0 ? rows[0].status as EffectOutboxStatus : null;
  }

  async function appendEventWithKey(
    instanceId: string,
    payload: unknown,
    idempotencyKey: string,
    topic = "event",
    source?: string,
  ): Promise<{ seq: number } | null> {
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, "utf-8") > MAX_EVENT_PAYLOAD_BYTES) {
      throw new DurableMachineError("Event payload exceeds 256 KB size limit", "INTERNAL");
    }
    const t = qStart();
    const { rows } = await pool.query({
      ...Q_APPEND_EVENT_WITH_KEY,
      values: [instanceId, topic, json, source ?? null, idempotencyKey, Date.now()],
    });
    qEnd(Q_APPEND_EVENT_WITH_KEY.name, t);
    // Returns null if the idempotency key already existed (ON CONFLICT DO NOTHING)
    return rows.length > 0 ? { seq: Number(rows[0].seq) } : null;
  }

  async function getInvokeSteps(instanceId: string): Promise<StepInfo[]> {
    const t = qStart();
    const { rows } = await pool.query({ ...Q_GET_INVOKE_STEPS, values: [instanceId] });
    qEnd(Q_GET_INVOKE_STEPS.name, t);
    return rows.map((row: any): StepInfo => {
      const payload = row.payload as Record<string, unknown>;
      const eventType = payload.type as string;
      const isError = eventType.startsWith("xstate.error.actor.");
      const actorId = eventType.replace(/^xstate\.(done|error)\.actor\./, "");
      return {
        name: `invoke:${actorId}`,
        output: isError ? undefined : payload.output,
        error: isError ? payload.error : undefined,
        completedAtEpochMs: Number(row.created_at),
      };
    });
  }

  // ── Step Cache (prompt-lifecycle) ────────────────────────────────────

  async function getStepCache(
    instanceId: string,
    stepKey: string,
  ): Promise<{ output: unknown; error: unknown } | null> {
    const t = qStart();
    const { rows } = await pool.query({ ...Q_GET_STEP_CACHE, values: [instanceId, stepKey] });
    qEnd(Q_GET_STEP_CACHE.name, t);
    if (rows.length === 0) return null;
    return { output: rows[0].output, error: rows[0].error };
  }

  async function setStepCache(params: SetStepCacheParams): Promise<void> {
    const { instanceId, stepKey, output, error, startedAt, completedAt, tenantId } = params;
    const t = qStart();
    await withTransaction(async (client) => {
      if (tenantId) await client.query({ text: `SELECT set_config('app.tenant_id', $1, true)`, values: [tenantId] });
      await client.query({
        ...Q_SET_STEP_CACHE,
        values: [instanceId, stepKey,
          output != null ? JSON.stringify(output) : null,
          error != null ? JSON.stringify(error) : null,
          startedAt ?? null, completedAt ?? null],
      });
    });
    qEnd(Q_SET_STEP_CACHE.name, t);
  }

  // ── CTE Finalize ───────────────────────────────────────────────────────

  async function finalizeInstance(params: FinalizeParams): Promise<void> {
    const { client, instanceId, stateValue, context, wakeAt, wakeEvent, firedDelays, status, eventCursor } = params;
    const t = qStart();
    await client.query({
      ...Q_FINALIZE_INSTANCE,
      values: [
        instanceId,
        JSON.stringify(stateValue),
        JSON.stringify(context),
        wakeAt,
        wakeEvent != null ? JSON.stringify(wakeEvent) : null,
        JSON.stringify(firedDelays),
        status,
        eventCursor,
        Date.now(),
      ],
    });
    qEnd(Q_FINALIZE_INSTANCE.name, t);
  }

  async function finalizeWithTransition(params: FinalizeParams & TransitionData): Promise<void> {
    const { client, instanceId, stateValue, context, wakeAt, wakeEvent, firedDelays, status, eventCursor, fromState, toState, event, ts, contextSnapshot } = params;
    const t = qStart();
    await client.query({
      ...Q_FINALIZE_WITH_TRANSITION,
      values: [
        instanceId,
        JSON.stringify(stateValue),
        JSON.stringify(context),
        wakeAt,
        wakeEvent != null ? JSON.stringify(wakeEvent) : null,
        JSON.stringify(firedDelays),
        status,
        eventCursor,
        Date.now(),
        fromState != null ? JSON.stringify(fromState) : null,
        JSON.stringify(toState),
        event,
        ts,
        contextSnapshot != null ? JSON.stringify(contextSnapshot) : null,
      ],
    });
    qEnd(Q_FINALIZE_WITH_TRANSITION.name, t);
  }

  // ── Transition Log ──────────────────────────────────────────────────────

  async function appendTransition(
    instanceId: string,
    fromState: StateValue | null,
    toState: StateValue,
    event: string | null,
    ts: number,
    contextSnapshot?: Record<string, unknown> | null,
    tenantId?: string,
  ): Promise<void> {
    const t = qStart();
    await withTransaction(async (client) => {
      if (tenantId) await client.query({ text: `SELECT set_config('app.tenant_id', $1, true)`, values: [tenantId] });
      await client.query({
        ...Q_APPEND_TRANSITION,
        values: [instanceId,
          fromState != null ? JSON.stringify(fromState) : null,
          JSON.stringify(toState),
          event, ts,
          contextSnapshot != null ? JSON.stringify(contextSnapshot) : null],
      });
    });
    qEnd(Q_APPEND_TRANSITION.name, t);
  }

  async function getTransitions(
    instanceId: string,
  ): Promise<TransitionRecord[]> {
    const t = qStart();
    const { rows } = await pool.query({ ...Q_GET_TRANSITIONS, values: [instanceId] });
    qEnd(Q_GET_TRANSITIONS.name, t);
    return rows.map(
      (row: any): TransitionRecord => ({
        from: row.from_state as StateValue | null,
        to: row.to_state as StateValue,
        event: row.event ?? null,
        ts: Number(row.ts),
        contextSnapshot: row.context_snapshot ?? null,
      }),
    );
  }

  // ── Effect Outbox ───────────────────────────────────────────────────

  async function insertEffects(params: InsertEffectsParams): Promise<void> {
    const { client, instanceId, machineName, stateValue, effects, maxAttempts = 3 } = params;
    if (effects.length === 0) return;
    const now = Date.now();
    const stateJson = JSON.stringify(stateValue);

    const instanceIds: string[] = [], stateValues: string[] = [], types: string[] = [];
    const payloads: string[] = [], maxAttemptsList: number[] = [], timestamps: number[] = [];
    const taskKinds: string[] = [], machineNames: string[] = [];
    for (const { type, ...payload } of effects) {
      instanceIds.push(instanceId); stateValues.push(stateJson); types.push(type);
      payloads.push(JSON.stringify(payload)); maxAttemptsList.push(maxAttempts); timestamps.push(now);
      taskKinds.push("effect"); machineNames.push(machineName ?? "");
    }
    const t = qStart();
    await client.query({
      ...Q_INSERT_EFFECTS,
      values: [instanceIds, stateValues, types, payloads, maxAttemptsList, timestamps, taskKinds, machineNames],
    });
    qEnd(Q_INSERT_EFFECTS.name, t);
    if (instr) for (const e of effects) instr.effectsEmittedTotal.add(1, { effect_type: e.type });
  }

  async function claimPendingTasks(limit = 50): Promise<TaskOutboxRow[]> {
    const t = qStart();
    const now = Date.now();
    const { rows } = await pool.query({ ...Q_CLAIM_PENDING_TASKS, values: [now, limit] });
    qEnd(Q_CLAIM_PENDING_TASKS.name, t);
    return rows.map(rowToTask);
  }

  async function markEffectCompleted(effectId: string): Promise<void> {
    const t = qStart();
    await pool.query({ ...Q_MARK_EFFECT_COMPLETED, values: [Date.now(), effectId] });
    qEnd(Q_MARK_EFFECT_COMPLETED.name, t);
  }

  async function markEffectFailed(
    effectId: string,
    error: string,
    nextRetryAt: number | null,
  ): Promise<void> {
    const t = qStart();
    const status = nextRetryAt != null ? "pending" : "failed";
    await pool.query({ ...Q_MARK_EFFECT_FAILED, values: [status, error, nextRetryAt, effectId] });
    qEnd(Q_MARK_EFFECT_FAILED.name, t);
  }

  async function listEffects(instanceId: string): Promise<EffectOutboxRow[]> {
    const t = qStart();
    const { rows } = await pool.query({ ...Q_LIST_EFFECTS, values: [instanceId] });
    qEnd(Q_LIST_EFFECTS.name, t);
    return rows.map(rowToEffect);
  }

  async function resetStaleEffects(olderThanMs: number): Promise<number> {
    const t = qStart();
    const { rowCount } = await pool.query({ ...Q_RESET_STALE_EFFECTS, values: [olderThanMs] });
    qEnd(Q_RESET_STALE_EFFECTS.name, t);
    return rowCount ?? 0;
  }

  // ── Analytics ───────────────────────────────────────────────────────
  async function getStateDurations(instanceId: string): Promise<StateDurationRow[]> {
    const t = qStart();
    const { rows } = await pool.query({ ...Q_STATE_DURATIONS, values: [instanceId] });
    qEnd(Q_STATE_DURATIONS.name, t);
    return rows.map((r: any): StateDurationRow => ({
      stateValue: r.state_value as StateValue,
      enteredAt: Number(r.entered_at),
      exitedAt: r.exited_at != null ? Number(r.exited_at) : null,
    }));
  }

  async function getAggregateStateDurations(machineName: string): Promise<AggregateStateDuration[]> {
    const t = qStart();
    const { rows } = await pool.query({ ...Q_AGGREGATE_STATE_DURATIONS, values: [machineName] });
    qEnd(Q_AGGREGATE_STATE_DURATIONS.name, t);
    return rows.map((r: any): AggregateStateDuration => ({
      stateValue: r.state_value as StateValue,
      avgMs: Number(r.avg_ms),
      minMs: Number(r.min_ms),
      maxMs: Number(r.max_ms),
      count: Number(r.count),
    }));
  }

  async function getTransitionCounts(machineName: string): Promise<TransitionCountRow[]> {
    const t = qStart();
    const { rows } = await pool.query({ ...Q_TRANSITION_COUNTS, values: [machineName] });
    qEnd(Q_TRANSITION_COUNTS.name, t);
    return rows.map((r: any): TransitionCountRow => ({
      fromState: r.from_state as StateValue | null,
      toState: r.to_state as StateValue,
      event: r.event as string | null,
      count: Number(r.count),
    }));
  }

  async function getInstanceSummaries(machineName: string): Promise<InstanceSummaryRow[]> {
    const t = qStart();
    const { rows } = await pool.query({ ...Q_INSTANCE_SUMMARIES, values: [machineName] });
    qEnd(Q_INSTANCE_SUMMARIES.name, t);
    return rows.map((r: any): InstanceSummaryRow => ({
      instanceId: r.instance_id,
      machineName: r.machine_name,
      status: r.status,
      startedAt: Number(r.started_at),
      updatedAt: Number(r.updated_at),
      currentState: r.current_state as StateValue,
      totalTransitions: Number(r.total_transitions),
    }));
  }

  // ── LISTEN/NOTIFY ─────────────────────────────────────────────────────

  const listener = createListenNotify(pool, useListenNotify);

  // ── Return ────────────────────────────────────────────────────────────

  const store: PgStore = {
    withTransaction,
    ensureSchema,
    ensureRoles,
    createInstance,
    getInstance,
    updateInstanceStatus,
    updateInstanceSnapshot,
    listInstances,
    lockAndGetInstance,
    appendEvent,
    lockAndPeekEvent,
    lockAndPeekEvents,
    getEventLog,
    getStepCache,
    setStepCache,
    queueInvokeTask,
    claimPendingTasks,
    checkInvokeEventExists,
    cancelInvokeTask,
    cancelInstanceInvokes,
    checkTaskStatus,
    appendEventWithKey,
    getInvokeSteps,
    finalizeInstance,
    finalizeWithTransition,
    appendTransition,
    getTransitions,
    insertEffects,
    markEffectCompleted,
    markEffectFailed,
    listEffects,
    resetStaleEffects,
    getStateDurations,
    getAggregateStateDurations,
    getTransitionCounts,
    getInstanceSummaries,
    forTenant(tenantId: string): PgStore {
      return createStore({
        ...options,
        pool: createTenantPool(pool, tenantId, "dm_tenant"),
        useListenNotify: false,
      });
    },
    startListening: listener.startListening,
    stopListening: listener.stopListening,
    close: listener.stopListening,
  };
  return store;
}
