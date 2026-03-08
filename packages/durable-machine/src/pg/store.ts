import type { Pool, PoolClient, Client as PgClient } from "pg";
import type { StateValue } from "xstate";
import type { StepInfo, TransitionRecord } from "../types.js";
import type { ResolvedEffect } from "../effects.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS machine_instances (
  id              TEXT PRIMARY KEY,
  machine_name    TEXT NOT NULL,
  state_value     JSONB NOT NULL,
  context         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',
  fired_delays    JSONB NOT NULL DEFAULT '[]',
  wake_at         BIGINT,
  input           JSONB,
  event_cursor    BIGINT NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mi_status ON machine_instances (status);
CREATE INDEX IF NOT EXISTS idx_mi_wake ON machine_instances (wake_at) WHERE wake_at IS NOT NULL AND status = 'running';
CREATE INDEX IF NOT EXISTS idx_mi_name ON machine_instances (machine_name);

CREATE TABLE IF NOT EXISTS invoke_results (
  instance_id     TEXT NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  step_key        TEXT NOT NULL,
  output          JSONB,
  error           JSONB,
  started_at      BIGINT,
  completed_at    BIGINT,
  PRIMARY KEY (instance_id, step_key)
);

CREATE TABLE IF NOT EXISTS event_log (
  instance_id     TEXT NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  seq             BIGSERIAL,
  topic           TEXT NOT NULL DEFAULT 'event',
  payload         JSONB NOT NULL,
  source          TEXT,
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (instance_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_el_pending
  ON event_log (instance_id, seq);

CREATE OR REPLACE FUNCTION event_log_notify() RETURNS trigger AS $$
DECLARE
  m_name TEXT;
BEGIN
  SELECT machine_name INTO m_name FROM machine_instances WHERE id = NEW.instance_id;
  PERFORM pg_notify('machine_event', m_name || '::' || NEW.instance_id || '::' || NEW.topic);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_log_trigger ON event_log;
CREATE TRIGGER event_log_trigger
  AFTER INSERT ON event_log FOR EACH ROW EXECUTE FUNCTION event_log_notify();

CREATE TABLE IF NOT EXISTS transition_log (
  instance_id     TEXT NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  seq             SERIAL,
  from_state      JSONB,
  to_state        JSONB NOT NULL,
  event           TEXT,
  ts              BIGINT NOT NULL,
  PRIMARY KEY (instance_id, seq)
);

CREATE TABLE IF NOT EXISTS effect_outbox (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id     TEXT NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  state_value     JSONB NOT NULL,
  effect_type     TEXT NOT NULL,
  effect_payload  JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  next_retry_at   BIGINT,
  last_error      TEXT,
  created_at      BIGINT NOT NULL,
  completed_at    BIGINT
);
CREATE INDEX IF NOT EXISTS idx_eo_pending
  ON effect_outbox (next_retry_at)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION effect_outbox_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('effect_pending', NEW.instance_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS effect_outbox_trigger ON effect_outbox;
CREATE TRIGGER effect_outbox_trigger
  AFTER INSERT ON effect_outbox FOR EACH ROW EXECUTE FUNCTION effect_outbox_notify();
`;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PgStoreOptions {
  pool: Pool;
  schema?: string;
  useListenNotify?: boolean;
}

export interface MachineRow {
  id: string;
  machineName: string;
  stateValue: StateValue;
  context: Record<string, unknown>;
  status: string;
  firedDelays: Array<string | number>;
  wakeAt: number | null;
  input: Record<string, unknown> | null;
  eventCursor: number;
  createdAt: number;
  updatedAt: number;
}

export interface EventLogEntry {
  seq: number;
  topic: string;
  payload: unknown;
  source: string | null;
  createdAt: number;
}

export interface EffectOutboxRow {
  id: string;
  instanceId: string;
  stateValue: StateValue;
  effectType: string;
  effectPayload: Record<string, unknown>;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface PgStore {
  // Schema
  ensureSchema(): Promise<void>;

  // Instance CRUD
  createInstance(
    id: string,
    machineName: string,
    stateValue: StateValue,
    context: Record<string, unknown>,
    input: Record<string, unknown> | null,
    wakeAt?: number | null,
    firedDelays?: Array<string | number>,
    queryable?: PoolClient,
  ): Promise<void>;
  getInstance(id: string): Promise<MachineRow | null>;
  updateInstance(
    id: string,
    patch: {
      stateValue?: StateValue;
      context?: Record<string, unknown>;
      wakeAt?: number | null;
      firedDelays?: Array<string | number>;
      status?: string;
      eventCursor?: number;
    },
    /** Optional client for transactional updates. */
    queryable?: PoolClient,
  ): Promise<void>;
  listInstances(filter?: {
    machineName?: string;
    status?: string;
  }): Promise<MachineRow[]>;

  // Locking
  lockAndGetInstance(
    client: PoolClient,
    id: string,
  ): Promise<MachineRow | null>;

  // Event log
  appendEvent(
    instanceId: string,
    payload: unknown,
    topic?: string,
    source?: string,
  ): Promise<{ seq: number }>;

  lockAndPeekEvent(
    client: PoolClient,
    instanceId: string,
  ): Promise<{
    row: MachineRow;
    nextEvent: { seq: number; payload: unknown } | null;
  } | null>;

  getEventLog(
    instanceId: string,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<EventLogEntry[]>;

  // Invoke results
  getInvokeResult(
    instanceId: string,
    stepKey: string,
  ): Promise<{ output: unknown; error: unknown } | null>;
  recordInvokeResult(
    instanceId: string,
    stepKey: string,
    output: unknown,
    error?: unknown,
    startedAt?: number,
    completedAt?: number,
  ): Promise<void>;
  listInvokeResults(instanceId: string): Promise<StepInfo[]>;

  // Transition log
  appendTransition(
    instanceId: string,
    fromState: StateValue | null,
    toState: StateValue,
    event: string | null,
    ts: number,
  ): Promise<void>;
  getTransitions(instanceId: string): Promise<TransitionRecord[]>;

  // Effect outbox
  insertEffects(
    client: PoolClient,
    instanceId: string,
    stateValue: StateValue,
    effects: ResolvedEffect[],
    maxAttempts?: number,
  ): Promise<void>;
  claimPendingEffects(limit?: number): Promise<EffectOutboxRow[]>;
  markEffectCompleted(effectId: string): Promise<void>;
  markEffectFailed(effectId: string, error: string, nextRetryAt: number | null): Promise<void>;
  listEffects(instanceId: string): Promise<EffectOutboxRow[]>;

  // LISTEN/NOTIFY
  startListening(
    callback: (machineName: string, instanceId: string, topic: string) => void,
  ): Promise<void>;
  stopListening(): Promise<void>;

  // Lifecycle
  close(): Promise<void>;
}

// ─── Row Mapping ────────────────────────────────────────────────────────────

function rowToMachine(row: any): MachineRow {
  return {
    id: row.id,
    machineName: row.machine_name,
    stateValue: row.state_value as StateValue,
    context: row.context as Record<string, unknown>,
    status: row.status,
    firedDelays: row.fired_delays as Array<string | number>,
    wakeAt: row.wake_at != null ? Number(row.wake_at) : null,
    input: row.input as Record<string, unknown> | null,
    eventCursor: Number(row.event_cursor),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createStore(options: PgStoreOptions): PgStore {
  const { pool, useListenNotify = true } = options;
  let listenClient: PgClient | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // ── Schema ──────────────────────────────────────────────────────────────

  async function ensureSchema(): Promise<void> {
    await pool.query(SCHEMA_SQL);
  }

  // ── Instance CRUD ───────────────────────────────────────────────────────

  async function createInstance(
    id: string,
    machineName: string,
    stateValue: StateValue,
    context: Record<string, unknown>,
    input: Record<string, unknown> | null,
    wakeAt?: number | null,
    firedDelays?: Array<string | number>,
    queryable?: PoolClient,
  ): Promise<void> {
    const q = queryable ?? pool;
    const now = Date.now();
    await q.query(
      `INSERT INTO machine_instances (id, machine_name, state_value, context, status, fired_delays, wake_at, input, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'running', $5, $6, $7, $8, $9)`,
      [
        id,
        machineName,
        JSON.stringify(stateValue),
        JSON.stringify(context),
        JSON.stringify(firedDelays ?? []),
        wakeAt ?? null,
        input != null ? JSON.stringify(input) : null,
        now,
        now,
      ],
    );
  }

  async function getInstance(id: string): Promise<MachineRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM machine_instances WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? rowToMachine(rows[0]) : null;
  }

  async function updateInstance(
    id: string,
    patch: {
      stateValue?: StateValue;
      context?: Record<string, unknown>;
      wakeAt?: number | null;
      firedDelays?: Array<string | number>;
      status?: string;
      eventCursor?: number;
    },
    queryable?: PoolClient,
  ): Promise<void> {
    const q = queryable ?? pool;
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (patch.stateValue !== undefined) {
      sets.push(`state_value = $${idx++}`);
      values.push(JSON.stringify(patch.stateValue));
    }
    if (patch.context !== undefined) {
      sets.push(`context = $${idx++}`);
      values.push(JSON.stringify(patch.context));
    }
    if (patch.wakeAt !== undefined) {
      sets.push(`wake_at = $${idx++}`);
      values.push(patch.wakeAt);
    }
    if (patch.firedDelays !== undefined) {
      sets.push(`fired_delays = $${idx++}`);
      values.push(JSON.stringify(patch.firedDelays));
    }
    if (patch.status !== undefined) {
      sets.push(`status = $${idx++}`);
      values.push(patch.status);
    }
    if (patch.eventCursor !== undefined) {
      sets.push(`event_cursor = $${idx++}`);
      values.push(patch.eventCursor);
    }

    if (sets.length === 0) return;

    sets.push(`updated_at = $${idx++}`);
    values.push(Date.now());

    values.push(id);
    await q.query(
      `UPDATE machine_instances SET ${sets.join(", ")} WHERE id = $${idx}`,
      values,
    );
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
    const { rows } = await client.query(
      `SELECT * FROM machine_instances WHERE id = $1 FOR NO KEY UPDATE NOWAIT`,
      [id],
    );
    return rows.length > 0 ? rowToMachine(rows[0]) : null;
  }

  // ── Event Log ───────────────────────────────────────────────────────────

  async function appendEvent(
    instanceId: string,
    payload: unknown,
    topic = "event",
    source?: string,
  ): Promise<{ seq: number }> {
    const { rows } = await pool.query(
      `INSERT INTO event_log (instance_id, topic, payload, source, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING seq`,
      [instanceId, topic, JSON.stringify(payload), source ?? null, Date.now()],
    );
    return { seq: Number(rows[0].seq) };
  }

  async function lockAndPeekEvent(
    client: PoolClient,
    instanceId: string,
  ): Promise<{
    row: MachineRow;
    nextEvent: { seq: number; payload: unknown } | null;
  } | null> {
    const { rows } = await client.query(
      `WITH locked AS (
        SELECT * FROM machine_instances WHERE id = $1 FOR NO KEY UPDATE NOWAIT
      )
      SELECT locked.*,
             e.seq AS next_event_seq,
             e.payload AS next_event_payload
      FROM locked
      LEFT JOIN LATERAL (
        SELECT seq, payload FROM event_log
        WHERE instance_id = locked.id AND seq > locked.event_cursor
        ORDER BY seq ASC LIMIT 1
      ) e ON true`,
      [instanceId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    const machineRow = rowToMachine(r);
    const nextEvent = r.next_event_seq != null
      ? { seq: Number(r.next_event_seq), payload: r.next_event_payload }
      : null;
    return { row: machineRow, nextEvent };
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
    const { rows } = await pool.query(
      `SELECT output, error FROM invoke_results WHERE instance_id = $1 AND step_key = $2`,
      [instanceId, stepKey],
    );
    if (rows.length === 0) return null;
    return { output: rows[0].output, error: rows[0].error };
  }

  async function recordInvokeResult(
    instanceId: string,
    stepKey: string,
    output: unknown,
    error?: unknown,
    startedAt?: number,
    completedAt?: number,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO invoke_results (instance_id, step_key, output, error, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (instance_id, step_key) DO NOTHING`,
      [
        instanceId,
        stepKey,
        output != null ? JSON.stringify(output) : null,
        error != null ? JSON.stringify(error) : null,
        startedAt ?? null,
        completedAt ?? null,
      ],
    );
  }

  async function listInvokeResults(instanceId: string): Promise<StepInfo[]> {
    const { rows } = await pool.query(
      `SELECT step_key, output, error, started_at, completed_at
       FROM invoke_results WHERE instance_id = $1 ORDER BY started_at ASC`,
      [instanceId],
    );
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

  // ── Transition Log ──────────────────────────────────────────────────────

  async function appendTransition(
    instanceId: string,
    fromState: StateValue | null,
    toState: StateValue,
    event: string | null,
    ts: number,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO transition_log (instance_id, from_state, to_state, event, ts)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        instanceId,
        fromState != null ? JSON.stringify(fromState) : null,
        JSON.stringify(toState),
        event,
        ts,
      ],
    );
  }

  async function getTransitions(
    instanceId: string,
  ): Promise<TransitionRecord[]> {
    const { rows } = await pool.query(
      `SELECT from_state, to_state, ts FROM transition_log
       WHERE instance_id = $1 ORDER BY seq ASC`,
      [instanceId],
    );
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
      status: row.status,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      lastError: row.last_error ?? null,
      createdAt: Number(row.created_at),
      completedAt: row.completed_at != null ? Number(row.completed_at) : null,
    };
  }

  async function insertEffects(
    client: PoolClient,
    instanceId: string,
    stateValue: StateValue,
    effects: ResolvedEffect[],
    maxAttempts = 3,
  ): Promise<void> {
    if (effects.length === 0) return;
    const now = Date.now();
    const stateJson = JSON.stringify(stateValue);
    for (const effect of effects) {
      const { type, ...payload } = effect;
      await client.query(
        `INSERT INTO effect_outbox (instance_id, state_value, effect_type, effect_payload, max_attempts, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [instanceId, stateJson, type, JSON.stringify(payload), maxAttempts, now],
      );
    }
  }

  async function claimPendingEffects(limit = 50): Promise<EffectOutboxRow[]> {
    const now = Date.now();
    const { rows } = await pool.query(
      `UPDATE effect_outbox
       SET status = 'executing', attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM effect_outbox
         WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= $1)
         ORDER BY created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [now, limit],
    );
    return rows.map(rowToEffect);
  }

  async function markEffectCompleted(effectId: string): Promise<void> {
    await pool.query(
      `UPDATE effect_outbox SET status = 'completed', completed_at = $1 WHERE id = $2`,
      [Date.now(), effectId],
    );
  }

  async function markEffectFailed(
    effectId: string,
    error: string,
    nextRetryAt: number | null,
  ): Promise<void> {
    const status = nextRetryAt != null ? "pending" : "failed";
    await pool.query(
      `UPDATE effect_outbox SET status = $1, last_error = $2, next_retry_at = $3 WHERE id = $4`,
      [status, error, nextRetryAt, effectId],
    );
  }

  async function listEffects(instanceId: string): Promise<EffectOutboxRow[]> {
    const { rows } = await pool.query(
      `SELECT * FROM effect_outbox WHERE instance_id = $1 ORDER BY created_at ASC`,
      [instanceId],
    );
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
      const { Client } = await import("pg");
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
    updateInstance,
    listInstances,
    lockAndGetInstance,
    appendEvent,
    lockAndPeekEvent,
    getEventLog,
    getInvokeResult,
    recordInvokeResult,
    listInvokeResults,
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
