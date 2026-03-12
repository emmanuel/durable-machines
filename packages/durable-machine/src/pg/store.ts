import type { PoolClient } from "pg";
import type { StateValue } from "xstate";
import type { StepInfo, TransitionRecord, InstanceStatus, EffectOutboxStatus } from "../types.js";
import { SCHEMA_SQL } from "./schema.js";
import { createListenNotify } from "./listen-notify.js";
import {
  Q_CREATE_INSTANCE, Q_GET_INSTANCE, Q_UPDATE_INSTANCE_STATUS,
  Q_UPDATE_INSTANCE_SNAPSHOT, Q_LOCK_AND_GET_INSTANCE,
  Q_APPEND_EVENT, Q_LOCK_AND_PEEK_EVENT, Q_LOCK_AND_PEEK_EVENTS,
  Q_GET_INVOKE_RESULT, Q_RECORD_INVOKE_RESULT, Q_LIST_INVOKE_RESULTS,
  Q_FINALIZE_INSTANCE, Q_FINALIZE_WITH_TRANSITION,
  Q_APPEND_TRANSITION, Q_GET_TRANSITIONS,
  Q_CLAIM_PENDING_EFFECTS, Q_MARK_EFFECT_COMPLETED, Q_MARK_EFFECT_FAILED,
  Q_LIST_EFFECTS, Q_RESET_STALE_EFFECTS,
  Q_LIST_INSTANCES, Q_LIST_INSTANCES_BY_MACHINE, Q_LIST_INSTANCES_BY_STATUS,
  Q_LIST_INSTANCES_BY_MACHINE_AND_STATUS,
  Q_GET_EVENT_LOG, Q_GET_EVENT_LOG_AFTER, Q_GET_EVENT_LOG_LIMIT,
  Q_GET_EVENT_LOG_AFTER_LIMIT,
  Q_INSERT_EFFECTS,
  Q_STATE_DURATIONS,
  Q_AGGREGATE_STATE_DURATIONS,
  Q_TRANSITION_COUNTS,
  Q_INSTANCE_SUMMARIES,
} from "./queries.js";
import { DurableMachineError } from "../types.js";
import type {
  PgStoreOptions, MachineRow, PgStore,
  CreateInstanceParams, FinalizeParams, TransitionData,
  RecordInvokeResultParams, InsertEffectsParams,
  EventLogEntry, EffectOutboxRow,
  StateDurationRow, AggregateStateDuration, TransitionCountRow, InstanceSummaryRow,
} from "./store-types.js";

export type {
  PgStoreOptions, MachineRow, EventLogEntry, EffectOutboxRow,
  CreateInstanceParams, FinalizeParams, TransitionData,
  RecordInvokeResultParams, InsertEffectsParams, PgStore,
  StateDurationRow, AggregateStateDuration, TransitionCountRow, InstanceSummaryRow,
} from "./store-types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Strip dangerous keys to prevent prototype pollution from deserialized JSON. */
function sanitizeContext(obj: unknown): Record<string, unknown> {
  if (typeof obj !== "object" || obj === null) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    result[key] = value;
  }
  return result;
}

// ─── Row Mapping ────────────────────────────────────────────────────────────

function rowToMachine(row: any): MachineRow {
  return {
    id: row.id,
    machineName: row.machine_name,
    stateValue: row.state_value as StateValue,
    context: sanitizeContext(row.context),
    status: row.status as InstanceStatus,
    firedDelays: row.fired_delays as Array<string | number>,
    wakeAt: row.wake_at != null ? Number(row.wake_at) : null,
    wakeEvent: row.wake_event ?? null,
    input: row.input as Record<string, unknown> | null,
    eventCursor: Number(row.event_cursor),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

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
    const hasMachine = !!filter?.machineName;
    const hasStatus = !!filter?.status;
    let result;
    if (hasMachine && hasStatus) {
      result = await pool.query({ ...Q_LIST_INSTANCES_BY_MACHINE_AND_STATUS, values: [filter!.machineName, filter!.status] });
    } else if (hasMachine) {
      result = await pool.query({ ...Q_LIST_INSTANCES_BY_MACHINE, values: [filter!.machineName] });
    } else if (hasStatus) {
      result = await pool.query({ ...Q_LIST_INSTANCES_BY_STATUS, values: [filter!.status] });
    } else {
      result = await pool.query({ ...Q_LIST_INSTANCES, values: [] as unknown[] });
    }
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
      values: [instanceId, topic, json, source ?? null, Date.now()],
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
    const hasAfter = opts?.afterSeq !== undefined;
    const hasLimit = opts?.limit !== undefined;
    let result;
    if (hasAfter && hasLimit) {
      result = await pool.query({ ...Q_GET_EVENT_LOG_AFTER_LIMIT, values: [instanceId, opts!.afterSeq, opts!.limit] });
    } else if (hasAfter) {
      result = await pool.query({ ...Q_GET_EVENT_LOG_AFTER, values: [instanceId, opts!.afterSeq] });
    } else if (hasLimit) {
      result = await pool.query({ ...Q_GET_EVENT_LOG_LIMIT, values: [instanceId, opts!.limit] });
    } else {
      result = await pool.query({ ...Q_GET_EVENT_LOG, values: [instanceId] });
    }
    qEnd("dm_get_event_log", t);
    return result.rows.map((r: any) => ({
      seq: Number(r.seq),
      topic: r.topic as string,
      payload: r.payload,
      source: r.source as string | null,
      createdAt: Number(r.created_at),
    }));
  }

  // ── Invoke Results ──────────────────────────────────────────────────────

  async function getInvokeResult(
    instanceId: string,
    stepKey: string,
  ): Promise<{ output: unknown; error: unknown } | null> {
    const t = qStart();
    const { rows } = await pool.query({ ...Q_GET_INVOKE_RESULT, values: [instanceId, stepKey] });
    qEnd(Q_GET_INVOKE_RESULT.name, t);
    if (rows.length === 0) return null;
    return { output: rows[0].output, error: rows[0].error };
  }

  async function recordInvokeResult(params: RecordInvokeResultParams): Promise<void> {
    const { instanceId, stepKey, output, error, startedAt, completedAt } = params;
    const t = qStart();
    await pool.query({
      ...Q_RECORD_INVOKE_RESULT,
      values: [
        instanceId,
        stepKey,
        output != null ? JSON.stringify(output) : null,
        error != null ? JSON.stringify(error) : null,
        startedAt ?? null,
        completedAt ?? null,
      ],
    });
    qEnd(Q_RECORD_INVOKE_RESULT.name, t);
  }

  async function listInvokeResults(instanceId: string): Promise<StepInfo[]> {
    const t = qStart();
    const { rows } = await pool.query({ ...Q_LIST_INVOKE_RESULTS, values: [instanceId] });
    qEnd(Q_LIST_INVOKE_RESULTS.name, t);
    return rows.map(
      (row: any): StepInfo => ({
        name: row.step_key,
        output: row.output,
        error: row.error,
        startedAtEpochMs: row.started_at != null ? Number(row.started_at) : undefined,
        completedAtEpochMs:
          row.completed_at != null ? Number(row.completed_at) : undefined,
      }),
    );
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
    const { client, instanceId, stateValue, context, wakeAt, wakeEvent, firedDelays, status, eventCursor, fromState, toState, event, ts } = params;
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
  ): Promise<void> {
    const t = qStart();
    await pool.query({
      ...Q_APPEND_TRANSITION,
      values: [
        instanceId,
        fromState != null ? JSON.stringify(fromState) : null,
        JSON.stringify(toState),
        event,
        ts,
      ],
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
        ts: Number(row.ts),
      }),
    );
  }

  // ── Effect Outbox ───────────────────────────────────────────────────

  function rowToEffect(row: any): EffectOutboxRow {
    return {
      id: row.id,
      instanceId: row.instance_id,
      stateValue: row.state_value as StateValue,
      effectType: row.effect_type,
      effectPayload: row.effect_payload as Record<string, unknown>,
      status: row.status as EffectOutboxStatus,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      lastError: row.last_error ?? null,
      createdAt: Number(row.created_at),
      completedAt: row.completed_at != null ? Number(row.completed_at) : null,
    };
  }

  async function insertEffects(params: InsertEffectsParams): Promise<void> {
    const { client, instanceId, stateValue, effects, maxAttempts = 3 } = params;
    if (effects.length === 0) return;
    const now = Date.now();
    const stateJson = JSON.stringify(stateValue);

    const instanceIds: string[] = [];
    const stateValues: string[] = [];
    const types: string[] = [];
    const payloads: string[] = [];
    const maxAttemptsList: number[] = [];
    const timestamps: number[] = [];

    for (const effect of effects) {
      const { type, ...payload } = effect;
      instanceIds.push(instanceId);
      stateValues.push(stateJson);
      types.push(type);
      payloads.push(JSON.stringify(payload));
      maxAttemptsList.push(maxAttempts);
      timestamps.push(now);
    }

    const t = qStart();
    await client.query({
      ...Q_INSERT_EFFECTS,
      values: [instanceIds, stateValues, types, payloads, maxAttemptsList, timestamps],
    });
    qEnd(Q_INSERT_EFFECTS.name, t);
  }

  async function claimPendingEffects(limit = 50): Promise<EffectOutboxRow[]> {
    const t = qStart();
    const now = Date.now();
    const { rows } = await pool.query({ ...Q_CLAIM_PENDING_EFFECTS, values: [now, limit] });
    qEnd(Q_CLAIM_PENDING_EFFECTS.name, t);
    return rows.map(rowToEffect);
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
    getInvokeResult,
    recordInvokeResult,
    listInvokeResults,
    finalizeInstance,
    finalizeWithTransition,
    appendTransition,
    getTransitions,
    insertEffects,
    claimPendingEffects,
    markEffectCompleted,
    markEffectFailed,
    listEffects,
    resetStaleEffects,
    getStateDurations,
    getAggregateStateDurations,
    getTransitionCounts,
    getInstanceSummaries,
    startListening: listener.startListening,
    stopListening: listener.stopListening,
    close: listener.stopListening,
  };
  return store;
}
