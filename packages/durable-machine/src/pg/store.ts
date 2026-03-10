import type { Pool, PoolClient, Client as PgClient } from "pg";
import type { StateValue } from "xstate";
import type { StepInfo, TransitionRecord, InstanceStatus, EffectOutboxStatus } from "../types.js";
import { SCHEMA_SQL } from "./schema.js";
import {
  Q_CREATE_INSTANCE, Q_GET_INSTANCE, Q_UPDATE_INSTANCE_STATUS,
  Q_UPDATE_INSTANCE_SNAPSHOT, Q_LOCK_AND_GET_INSTANCE,
  Q_APPEND_EVENT, Q_LOCK_AND_PEEK_EVENT, Q_LOCK_AND_PEEK_EVENTS,
  Q_GET_INVOKE_RESULT, Q_RECORD_INVOKE_RESULT, Q_LIST_INVOKE_RESULTS,
  Q_FINALIZE_INSTANCE, Q_FINALIZE_WITH_TRANSITION,
  Q_APPEND_TRANSITION, Q_GET_TRANSITIONS,
  Q_CLAIM_PENDING_EFFECTS, Q_MARK_EFFECT_COMPLETED, Q_MARK_EFFECT_FAILED,
  Q_LIST_EFFECTS,
} from "./queries.js";
import type {
  PgStoreOptions, MachineRow, PgStore,
  CreateInstanceParams, FinalizeParams, TransitionData,
  RecordInvokeResultParams, InsertEffectsParams,
  EventLogEntry, EffectOutboxRow,
} from "./store-types.js";

export type {
  PgStoreOptions, MachineRow, EventLogEntry, EffectOutboxRow,
  CreateInstanceParams, FinalizeParams, TransitionData,
  RecordInvokeResultParams, InsertEffectsParams, PgStore,
} from "./store-types.js";

// ─── Row Mapping ────────────────────────────────────────────────────────────

function rowToMachine(row: any): MachineRow {
  return {
    id: row.id,
    machineName: row.machine_name,
    stateValue: row.state_value as StateValue,
    context: row.context as Record<string, unknown>,
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
  let listenClient: PgClient | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Query timing helpers — zero overhead when instruments not provided
  function qStart(): number { return instr ? performance.now() : 0; }
  function qEnd(name: string, start: number): void {
    if (instr) instr.queryDuration.record(performance.now() - start, { query: name });
  }

  // ── Schema ──────────────────────────────────────────────────────────────

  async function ensureSchema(): Promise<void> {
    await pool.query(SCHEMA_SQL);
  }

  // ── Instance CRUD ───────────────────────────────────────────────────────

  async function createInstance(params: CreateInstanceParams): Promise<void> {
    const { id, machineName, stateValue, context, input, wakeAt, firedDelays, queryable, wakeEvent } = params;
    const q = queryable ?? pool;
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
  }

  async function getInstance(id: string): Promise<MachineRow | null> {
    const { rows } = await pool.query({ ...Q_GET_INSTANCE, values: [id] });
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
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (filter?.machineName) {
      conditions.push(`machine_name = $${idx++}`);
      values.push(filter.machineName);
    }
    if (filter?.status) {
      conditions.push(`status = $${idx++}`);
      values.push(filter.status);
    }

    const where =
      conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `SELECT * FROM machine_instances${where} ORDER BY created_at ASC`,
      values,
    );
    return rows.map(rowToMachine);
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

  async function appendEvent(
    instanceId: string,
    payload: unknown,
    topic = "event",
    source?: string,
  ): Promise<{ seq: number }> {
    const t = qStart();
    const { rows } = await pool.query({
      ...Q_APPEND_EVENT,
      values: [instanceId, topic, JSON.stringify(payload), source ?? null, Date.now()],
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
    const nextEvent = r.next_event_seq != null
      ? { seq: Number(r.next_event_seq), payload: r.next_event_payload }
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
      if (r.event_seq != null) {
        events.push({ seq: Number(r.event_seq), payload: r.event_payload });
      }
    }
    return { row: machineRow, events };
  }

  async function getEventLog(
    instanceId: string,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<EventLogEntry[]> {
    const conditions = ["instance_id = $1"];
    const values: unknown[] = [instanceId];
    let idx = 2;

    if (opts?.afterSeq !== undefined) {
      conditions.push(`seq > $${idx++}`);
      values.push(opts.afterSeq);
    }

    let sql = `SELECT seq, topic, payload, source, created_at FROM event_log
       WHERE ${conditions.join(" AND ")}
       ORDER BY seq ASC`;

    if (opts?.limit !== undefined) {
      sql += ` LIMIT $${idx++}`;
      values.push(opts.limit);
    }

    const { rows } = await pool.query(sql, values);
    return rows.map((r: any) => ({
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
    const { rows } = await pool.query({ ...Q_LIST_INVOKE_RESULTS, values: [instanceId] });
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
  }

  async function getTransitions(
    instanceId: string,
  ): Promise<TransitionRecord[]> {
    const { rows } = await pool.query({ ...Q_GET_TRANSITIONS, values: [instanceId] });
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

    // Build multi-row INSERT (dynamic placeholder count)
    const placeholders: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    for (const effect of effects) {
      const { type, ...payload } = effect;
      placeholders.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`,
      );
      values.push(
        instanceId, stateJson, type, JSON.stringify(payload), maxAttempts, now,
      );
    }

    await client.query(
      `INSERT INTO effect_outbox (instance_id, state_value, effect_type, effect_payload, max_attempts, created_at)
       VALUES ${placeholders.join(", ")}`,
      values,
    );
  }

  async function claimPendingEffects(limit = 50): Promise<EffectOutboxRow[]> {
    const now = Date.now();
    const { rows } = await pool.query({ ...Q_CLAIM_PENDING_EFFECTS, values: [now, limit] });
    return rows.map(rowToEffect);
  }

  async function markEffectCompleted(effectId: string): Promise<void> {
    await pool.query({ ...Q_MARK_EFFECT_COMPLETED, values: [Date.now(), effectId] });
  }

  async function markEffectFailed(
    effectId: string,
    error: string,
    nextRetryAt: number | null,
  ): Promise<void> {
    const status = nextRetryAt != null ? "pending" : "failed";
    await pool.query({ ...Q_MARK_EFFECT_FAILED, values: [status, error, nextRetryAt, effectId] });
  }

  async function listEffects(instanceId: string): Promise<EffectOutboxRow[]> {
    const { rows } = await pool.query({ ...Q_LIST_EFFECTS, values: [instanceId] });
    return rows.map(rowToEffect);
  }

  // ── LISTEN/NOTIFY ─────────────────────────────────────────────────────

  let listenCallback:
    | ((machineName: string, instanceId: string, topic: string) => void)
    | null = null;

  async function connectListener(): Promise<void> {
    if (stopped || !useListenNotify) return;

    try {
      // Create a dedicated client (not from pool) for LISTEN
      const pg = await import("pg");
      const Client = pg.default?.Client ?? pg.Client;
      const client = new Client(
        (pool as any).options ?? {
          connectionString: (pool as any)._connectionString,
        },
      );
      await client.connect();
      await client.query("LISTEN machine_event");

      listenClient = client as unknown as PgClient;

      client.on("notification", (msg: any) => {
        if (msg.channel === "machine_event" && msg.payload && listenCallback) {
          const [machineName, instanceId, topic] = msg.payload.split("::");
          listenCallback(machineName, instanceId, topic ?? "event");
        }
      });

      client.on("error", () => {
        reconnect();
      });

      client.on("end", () => {
        if (!stopped) reconnect();
      });
    } catch {
      reconnect();
    }
  }

  function reconnect(): void {
    if (stopped) return;
    if (listenClient) {
      (listenClient as any).end().catch(() => {});
      listenClient = null;
    }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      void connectListener();
    }, 1000);
  }

  async function startListening(
    callback: (machineName: string, instanceId: string, topic: string) => void,
  ): Promise<void> {
    listenCallback = callback;
    if (useListenNotify) {
      await connectListener();
    }
  }

  async function stopListening(): Promise<void> {
    stopped = true;
    listenCallback = null;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (listenClient) {
      await (listenClient as any).end().catch(() => {});
      listenClient = null;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async function close(): Promise<void> {
    await stopListening();
  }

  // ── Return ────────────────────────────────────────────────────────────

  const store: PgStore & { _pool: Pool } = {
    _pool: pool,
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
    startListening,
    stopListening,
    close,
  };
  return store;
}
