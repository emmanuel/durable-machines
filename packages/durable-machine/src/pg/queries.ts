// ─── Instance CRUD ───────────────────────────────────────────────────────────

export const Q_CREATE_INSTANCE = {
  name: "dm_create_instance",
  text: `INSERT INTO machine_instances (id, machine_name, state_value, context, status, fired_delays, wake_at, wake_event, input, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'running', $5, $6, $7, $8, $9, $10)`,
} as const;

export const Q_GET_INSTANCE = {
  name: "dm_get_instance",
  text: `SELECT * FROM machine_instances WHERE id = $1`,
} as const;

export const Q_UPDATE_INSTANCE_STATUS = {
  name: "dm_update_instance_status",
  text: `UPDATE machine_instances SET status = $2, updated_at = $3 WHERE id = $1`,
} as const;

export const Q_UPDATE_INSTANCE_SNAPSHOT = {
  name: "dm_update_instance_snapshot",
  text: `UPDATE machine_instances SET state_value = $2, context = $3, updated_at = $4 WHERE id = $1`,
} as const;

// ─── Locking ─────────────────────────────────────────────────────────────────

export const Q_LOCK_AND_GET_INSTANCE = {
  name: "dm_lock_and_get_instance",
  text: `SELECT * FROM machine_instances WHERE id = $1 FOR NO KEY UPDATE`,
} as const;

// ─── Event Log ───────────────────────────────────────────────────────────────

export const Q_APPEND_EVENT = {
  name: "dm_append_event",
  text: `INSERT INTO event_log (instance_id, topic, payload, source, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING seq`,
} as const;

// Lock instance + peek events in a single round-trip CTE.
// Uses blocking FOR NO KEY UPDATE (not SKIP LOCKED) — SKIP LOCKED can
// spuriously skip unlocked rows due to PG plan-caching/visibility issues.

export const Q_LOCK_AND_PEEK_EVENT = {
  name: "dm_lock_and_peek_event",
  text: `WITH locked AS (
           SELECT * FROM machine_instances WHERE id = $1 FOR NO KEY UPDATE
         )
         SELECT locked.*, e.seq AS evt_seq, e.payload AS evt_payload
         FROM locked
         LEFT JOIN LATERAL (
           SELECT seq, payload FROM event_log
           WHERE instance_id = $1 AND seq > locked.event_cursor
           ORDER BY seq ASC LIMIT 1
         ) e ON true`,
} as const;

export const Q_LOCK_AND_PEEK_EVENTS = {
  name: "dm_lock_and_peek_events",
  text: `WITH locked AS (
           SELECT * FROM machine_instances WHERE id = $1 FOR NO KEY UPDATE
         )
         SELECT locked.*, e.seq AS evt_seq, e.payload AS evt_payload
         FROM locked
         LEFT JOIN LATERAL (
           SELECT seq, payload FROM event_log
           WHERE instance_id = $1 AND seq > locked.event_cursor
           ORDER BY seq ASC LIMIT $2
         ) e ON true`,
} as const;

// ─── Invoke Results ──────────────────────────────────────────────────────────

export const Q_GET_INVOKE_RESULT = {
  name: "dm_get_invoke_result",
  text: `SELECT output, error FROM invoke_results WHERE instance_id = $1 AND step_key = $2`,
} as const;

export const Q_RECORD_INVOKE_RESULT = {
  name: "dm_record_invoke_result",
  text: `INSERT INTO invoke_results (instance_id, step_key, output, error, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (instance_id, step_key) DO NOTHING`,
} as const;

export const Q_LIST_INVOKE_RESULTS = {
  name: "dm_list_invoke_results",
  text: `SELECT step_key, output, error, started_at, completed_at
       FROM invoke_results WHERE instance_id = $1 ORDER BY started_at ASC`,
} as const;

// ─── CTE Finalize ────────────────────────────────────────────────────────────

export const Q_FINALIZE_INSTANCE = {
  name: "dm_finalize_instance",
  text: `UPDATE machine_instances
             SET state_value=$2, context=$3, wake_at=$4, wake_event=$5,
                 fired_delays=$6, status=$7, event_cursor=$8, updated_at=$9
             WHERE id = $1`,
} as const;

export const Q_FINALIZE_WITH_TRANSITION = {
  name: "dm_finalize_with_transition",
  text: `WITH upd AS (
        UPDATE machine_instances
        SET state_value=$2, context=$3, wake_at=$4, wake_event=$5,
            fired_delays=$6, status=$7, event_cursor=$8, updated_at=$9
        WHERE id = $1
      )
      INSERT INTO transition_log (instance_id, from_state, to_state, event, ts, context_snapshot)
      VALUES ($1, $10, $11, $12, $13, $14)`,
} as const;

// ─── Transition Log ──────────────────────────────────────────────────────────

export const Q_APPEND_TRANSITION = {
  name: "dm_append_transition",
  text: `INSERT INTO transition_log (instance_id, from_state, to_state, event, ts, context_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6)`,
} as const;

export const Q_GET_TRANSITIONS = {
  name: "dm_get_transitions",
  text: `SELECT from_state, to_state, event, ts, context_snapshot FROM transition_log
       WHERE instance_id = $1 ORDER BY seq ASC`,
} as const;

// ─── Effect Outbox ───────────────────────────────────────────────────────────

export const Q_CLAIM_PENDING_EFFECTS = {
  name: "dm_claim_pending_effects",
  text: `UPDATE effect_outbox
       SET status = 'executing', attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM effect_outbox
         WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= $1)
         ORDER BY created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
} as const;

export const Q_MARK_EFFECT_COMPLETED = {
  name: "dm_mark_effect_completed",
  text: `UPDATE effect_outbox SET status = 'completed', completed_at = $1 WHERE id = $2`,
} as const;

export const Q_MARK_EFFECT_FAILED = {
  name: "dm_mark_effect_failed",
  text: `UPDATE effect_outbox SET status = $1, last_error = $2, next_retry_at = $3 WHERE id = $4`,
} as const;

export const Q_LIST_EFFECTS = {
  name: "dm_list_effects",
  text: `SELECT * FROM effect_outbox WHERE instance_id = $1 ORDER BY created_at ASC`,
} as const;

export const Q_RESET_STALE_EFFECTS = {
  name: "dm_reset_stale_effects",
  text: `UPDATE effect_outbox
         SET status = 'pending'
         WHERE status = 'executing'
           AND created_at < $1
         RETURNING id`,
} as const;

// ─── List Instances (4 filter combinations) ─────────────────────────────────

export const Q_LIST_INSTANCES = {
  name: "dm_list_instances",
  text: `SELECT * FROM machine_instances ORDER BY created_at ASC`,
} as const;

export const Q_LIST_INSTANCES_BY_MACHINE = {
  name: "dm_list_instances_by_machine",
  text: `SELECT * FROM machine_instances WHERE machine_name = $1 ORDER BY created_at ASC`,
} as const;

export const Q_LIST_INSTANCES_BY_STATUS = {
  name: "dm_list_instances_by_status",
  text: `SELECT * FROM machine_instances WHERE status = $1 ORDER BY created_at ASC`,
} as const;

export const Q_LIST_INSTANCES_BY_MACHINE_AND_STATUS = {
  name: "dm_list_instances_by_machine_and_status",
  text: `SELECT * FROM machine_instances WHERE machine_name = $1 AND status = $2 ORDER BY created_at ASC`,
} as const;

// ─── Event Log (4 filter combinations) ──────────────────────────────────────

export const Q_GET_EVENT_LOG = {
  name: "dm_get_event_log",
  text: `SELECT seq, topic, payload, source, created_at FROM event_log
         WHERE instance_id = $1 ORDER BY seq ASC`,
} as const;

export const Q_GET_EVENT_LOG_AFTER = {
  name: "dm_get_event_log_after",
  text: `SELECT seq, topic, payload, source, created_at FROM event_log
         WHERE instance_id = $1 AND seq > $2 ORDER BY seq ASC`,
} as const;

export const Q_GET_EVENT_LOG_LIMIT = {
  name: "dm_get_event_log_limit",
  text: `SELECT seq, topic, payload, source, created_at FROM event_log
         WHERE instance_id = $1 ORDER BY seq ASC LIMIT $2`,
} as const;

export const Q_GET_EVENT_LOG_AFTER_LIMIT = {
  name: "dm_get_event_log_after_limit",
  text: `SELECT seq, topic, payload, source, created_at FROM event_log
         WHERE instance_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
} as const;

// ─── Effect Outbox Insert (UNNEST) ──────────────────────────────────────────

export const Q_INSERT_EFFECTS = {
  name: "dm_insert_effects",
  text: `INSERT INTO effect_outbox (instance_id, state_value, effect_type, effect_payload, max_attempts, created_at)
         SELECT * FROM UNNEST($1::uuid[], $2::jsonb[], $3::text[], $4::jsonb[], $5::int[], $6::bigint[])`,
} as const;

// ─── Analytics ───────────────────────────────────────────────────────────────

export const Q_STATE_DURATIONS = {
  name: "dm_state_durations",
  text: `SELECT t.to_state AS state_value, t.ts AS entered_at,
                LEAD(t.ts) OVER (PARTITION BY t.instance_id ORDER BY t.seq) AS exited_at
         FROM transition_log t
         WHERE t.instance_id = $1
         ORDER BY t.seq ASC`,
} as const;

export const Q_AGGREGATE_STATE_DURATIONS = {
  name: "dm_agg_state_durations",
  text: `WITH durations AS (
           SELECT t.to_state AS state_value, t.ts AS entered_at,
                  LEAD(t.ts) OVER (PARTITION BY t.instance_id ORDER BY t.seq) AS exited_at
           FROM transition_log t
           JOIN machine_instances mi ON t.instance_id = mi.id
           WHERE mi.machine_name = $1
         )
         SELECT state_value,
                AVG(exited_at - entered_at)::bigint AS avg_ms,
                MIN(exited_at - entered_at)::bigint AS min_ms,
                MAX(exited_at - entered_at)::bigint AS max_ms,
                COUNT(*)::int AS count
         FROM durations
         WHERE exited_at IS NOT NULL
         GROUP BY state_value`,
} as const;

export const Q_TRANSITION_COUNTS = {
  name: "dm_transition_counts",
  text: `SELECT t.from_state, t.to_state, t.event, COUNT(*)::int AS count
         FROM transition_log t
         JOIN machine_instances mi ON t.instance_id = mi.id
         WHERE mi.machine_name = $1
         GROUP BY t.from_state, t.to_state, t.event
         ORDER BY count DESC`,
} as const;

export const Q_INSTANCE_SUMMARIES = {
  name: "dm_instance_summaries",
  text: `SELECT mi.id AS instance_id, mi.machine_name, mi.status,
                mi.created_at AS started_at, mi.updated_at,
                mi.state_value AS current_state,
                COUNT(t.seq)::int AS total_transitions
         FROM machine_instances mi
         LEFT JOIN transition_log t ON t.instance_id = mi.id
         WHERE mi.machine_name = $1
         GROUP BY mi.id
         ORDER BY mi.created_at DESC`,
} as const;

// ─── Tenant Queries ─────────────────────────────────────────────────────────

export const Q_LOOKUP_TENANT = {
  name: "dm_lookup_tenant",
  text: `SELECT id, jwks_url FROM tenants WHERE jwt_iss = $1 AND jwt_aud = $2`,
} as const;

// ─── Client Queries ──────────────────────────────────────────────────────────

export const Q_SEND_MACHINE_EVENT = {
  name: "dm_send_machine_event",
  text: `INSERT INTO event_log (instance_id, topic, payload, created_at)
       VALUES ($1, 'event', $2, $3)`,
} as const;

export const Q_SEND_MACHINE_EVENT_BATCH = {
  name: "dm_send_machine_event_batch",
  text: `INSERT INTO event_log (instance_id, topic, payload, created_at)
       SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::jsonb[], $4::bigint[])`,
} as const;

export const Q_GET_MACHINE_STATE = {
  name: "dm_get_machine_state",
  text: `SELECT state_value, context, status FROM machine_instances WHERE id = $1`,
} as const;
