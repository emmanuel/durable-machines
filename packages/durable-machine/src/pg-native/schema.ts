/**
 * PG-native schema: extends the base schema with machine_definitions table
 * and PL/pgSQL functions that delegate state machine logic to the Rust
 * `statechart` PostgreSQL extension (sc_create / sc_send).
 */
export const NATIVE_SCHEMA_SQL = `
-- ============================================================================
-- Schema additions
-- ============================================================================

CREATE TABLE IF NOT EXISTS machine_definitions (
  machine_name    TEXT PRIMARY KEY,
  definition      JSONB NOT NULL,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);

ALTER TABLE machine_instances ADD COLUMN IF NOT EXISTS definition_override JSONB;

-- ============================================================================
-- 1a: dm_register_definition
-- ============================================================================

CREATE OR REPLACE FUNCTION dm_register_definition(
  p_machine_name  TEXT,
  p_definition    JSONB
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_now BIGINT := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
BEGIN
  INSERT INTO machine_definitions (machine_name, definition, created_at, updated_at)
  VALUES (p_machine_name, p_definition, v_now, v_now)
  ON CONFLICT (machine_name)
  DO UPDATE SET definition = EXCLUDED.definition,
                updated_at = EXCLUDED.updated_at;
END;
$$;

-- ============================================================================
-- 1b: dm_create_instance
-- ============================================================================

CREATE OR REPLACE FUNCTION dm_create_instance(
  p_id                   UUID,
  p_machine_name         TEXT,
  p_input                JSONB,
  p_definition_override  JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_config    JSONB;
  v_result    JSONB;
  v_snapshot  JSONB;
  v_status    TEXT;
  v_now       BIGINT := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
  v_effects   JSONB;
  v_invocation JSONB;
  v_wake_at   BIGINT;
  v_wake_event JSONB;
  v_fired_delays JSONB;

  -- Arrays for batch effect insert
  v_eff_instance_ids UUID[];
  v_eff_state_values JSONB[];
  v_eff_types        TEXT[];
  v_eff_payloads     JSONB[];
  v_eff_max_attempts INT[];
  v_eff_created_ats  BIGINT[];
  v_eff_count        INT;
  i                  INT;
BEGIN
  -- Load definition: override takes precedence over registered definition
  v_config := COALESCE(
    p_definition_override,
    (SELECT definition FROM machine_definitions WHERE machine_name = p_machine_name)
  );

  IF v_config IS NULL THEN
    RAISE EXCEPTION 'No definition found for machine "%"', p_machine_name;
  END IF;

  -- Call statechart extension to compute initial state
  v_result := sc_create(v_config, p_input);

  v_snapshot     := v_result->'snapshot';
  v_status       := COALESCE(v_result->>'status', 'running');
  v_effects      := v_result->'effects';
  v_invocation   := v_result->'invocation';
  v_wake_at      := (v_result->>'wakeAt')::BIGINT;
  v_wake_event   := v_result->'wakeEvent';
  v_fired_delays := COALESCE(v_result->'firedDelays', '[]'::JSONB);

  -- Insert the machine instance
  INSERT INTO machine_instances (
    id, machine_name, state_value, context, status,
    fired_delays, wake_at, wake_event, definition_override,
    input, created_at, updated_at
  ) VALUES (
    p_id, p_machine_name, v_snapshot->'value', v_snapshot->'context', v_status,
    v_fired_delays, v_wake_at, v_wake_event, p_definition_override,
    p_input, v_now, v_now
  );

  -- Insert effects into outbox using UNNEST batch pattern
  IF v_effects IS NOT NULL AND jsonb_array_length(v_effects) > 0 THEN
    v_eff_count := jsonb_array_length(v_effects);
    v_eff_instance_ids := ARRAY[]::UUID[];
    v_eff_state_values := ARRAY[]::JSONB[];
    v_eff_types        := ARRAY[]::TEXT[];
    v_eff_payloads     := ARRAY[]::JSONB[];
    v_eff_max_attempts := ARRAY[]::INT[];
    v_eff_created_ats  := ARRAY[]::BIGINT[];

    FOR i IN 0 .. v_eff_count - 1 LOOP
      v_eff_instance_ids := array_append(v_eff_instance_ids, p_id);
      v_eff_state_values := array_append(v_eff_state_values, v_snapshot->'value');
      v_eff_types        := array_append(v_eff_types, v_effects->i->>'type');
      v_eff_payloads     := array_append(v_eff_payloads, v_effects->i);
      v_eff_max_attempts := array_append(v_eff_max_attempts, 3);
      v_eff_created_ats  := array_append(v_eff_created_ats, v_now);
    END LOOP;

    INSERT INTO effect_outbox (instance_id, state_value, effect_type, effect_payload, max_attempts, created_at)
    SELECT * FROM UNNEST(
      v_eff_instance_ids,
      v_eff_state_values,
      v_eff_types,
      v_eff_payloads,
      v_eff_max_attempts,
      v_eff_created_ats
    );
  END IF;

  -- Insert initial transition log entry (from=NULL, to=initial_state)
  INSERT INTO transition_log (instance_id, from_state, to_state, event, ts, context_snapshot)
  VALUES (p_id, NULL, v_snapshot->'value', 'xstate.init', v_now, v_snapshot->'context');

  RETURN jsonb_build_object('status', v_status, 'invocation', v_invocation);
END;
$$;

-- ============================================================================
-- 1c: dm_process_events
-- ============================================================================

CREATE OR REPLACE FUNCTION dm_process_events(
  p_instance_id  UUID,
  p_limit        INTEGER DEFAULT 50
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_mi           RECORD;
  v_config       JSONB;
  v_snapshot     JSONB;
  v_prev_state   JSONB;
  v_result       JSONB;
  v_invocation   JSONB := NULL;
  v_processed    INT := 0;
  v_status       TEXT;
  v_now          BIGINT;
  v_cursor       BIGINT;

  -- Current row state fields
  v_wake_at      BIGINT;
  v_wake_event   JSONB;
  v_fired_delays JSONB;

  -- Event loop variables
  v_evt          RECORD;

  -- Arrays for batch effect insert
  v_eff_instance_ids UUID[];
  v_eff_state_values JSONB[];
  v_eff_types        TEXT[];
  v_eff_payloads     JSONB[];
  v_eff_max_attempts INT[];
  v_eff_created_ats  BIGINT[];
  v_effects          JSONB;
  v_eff_count        INT;
  i                  INT;

  -- Arrays for batch transition log insert
  v_tr_instance_ids      UUID[];
  v_tr_from_states       JSONB[];
  v_tr_to_states         JSONB[];
  v_tr_events            TEXT[];
  v_tr_timestamps        BIGINT[];
  v_tr_context_snapshots JSONB[];
BEGIN
  -- Step 1: Lock the instance row
  SELECT * INTO v_mi
  FROM machine_instances
  WHERE id = p_instance_id
  FOR NO KEY UPDATE;

  -- Bail if not found
  IF NOT FOUND THEN
    RETURN jsonb_build_object('processed', 0, 'status', 'not_found', 'invocation', NULL);
  END IF;

  -- Bail if not running
  IF v_mi.status != 'running' THEN
    RETURN jsonb_build_object('processed', 0, 'status', v_mi.status, 'invocation', NULL);
  END IF;

  -- Step 3: Load config from definition_override or machine_definitions
  -- Use subquery (not JOIN) so definition_override works even when no
  -- machine_definitions row exists for this machine_name
  v_config := COALESCE(
    v_mi.definition_override,
    (SELECT definition FROM machine_definitions WHERE machine_name = v_mi.machine_name)
  );

  IF v_config IS NULL THEN
    RAISE EXCEPTION 'No definition found for machine "%"', v_mi.machine_name;
  END IF;

  -- Step 4: Build snapshot JSONB from row
  v_snapshot := jsonb_build_object('value', v_mi.state_value, 'context', v_mi.context);
  v_prev_state := v_mi.state_value;
  v_status := v_mi.status;
  v_cursor := v_mi.event_cursor;
  v_wake_at := v_mi.wake_at;
  v_wake_event := v_mi.wake_event;
  v_fired_delays := v_mi.fired_delays;
  v_now := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;

  -- Initialize batch arrays
  v_eff_instance_ids     := ARRAY[]::UUID[];
  v_eff_state_values     := ARRAY[]::JSONB[];
  v_eff_types            := ARRAY[]::TEXT[];
  v_eff_payloads         := ARRAY[]::JSONB[];
  v_eff_max_attempts     := ARRAY[]::INT[];
  v_eff_created_ats      := ARRAY[]::BIGINT[];
  v_tr_instance_ids      := ARRAY[]::UUID[];
  v_tr_from_states       := ARRAY[]::JSONB[];
  v_tr_to_states         := ARRAY[]::JSONB[];
  v_tr_events            := ARRAY[]::TEXT[];
  v_tr_timestamps        := ARRAY[]::BIGINT[];
  v_tr_context_snapshots := ARRAY[]::JSONB[];

  -- Step 6: Process events
  FOR v_evt IN
    SELECT seq, payload
    FROM event_log
    WHERE instance_id = p_instance_id AND seq > v_mi.event_cursor
    ORDER BY seq ASC
    LIMIT p_limit
  LOOP
    -- Call statechart extension to compute next state
    v_result := sc_send(v_config, v_snapshot, v_evt.payload->>'type', v_evt.payload);

    -- Update snapshot from result (must happen before invocation check
    -- so the state change from the invoking event is persisted)
    v_snapshot := v_result->'snapshot';
    v_processed := v_processed + 1;

    -- If invocation is needed, save info and exit loop
    IF v_result->'invocation' IS NOT NULL AND v_result->>'invocation' != 'null' THEN
      v_invocation := v_result->'invocation';
      v_cursor := v_evt.seq;
      EXIT;
    END IF;

    -- Collect effects from result
    v_effects := v_result->'effects';
    IF v_effects IS NOT NULL AND jsonb_array_length(v_effects) > 0 THEN
      v_eff_count := jsonb_array_length(v_effects);
      FOR i IN 0 .. v_eff_count - 1 LOOP
        v_eff_instance_ids := array_append(v_eff_instance_ids, p_instance_id);
        v_eff_state_values := array_append(v_eff_state_values, v_snapshot->'value');
        v_eff_types        := array_append(v_eff_types, v_effects->i->>'type');
        v_eff_payloads     := array_append(v_eff_payloads, v_effects->i);
        v_eff_max_attempts := array_append(v_eff_max_attempts, 3);
        v_eff_created_ats  := array_append(v_eff_created_ats, v_now);
      END LOOP;
    END IF;

    -- Track state transitions (from -> to)
    IF v_snapshot->'value' IS DISTINCT FROM v_prev_state THEN
      v_tr_instance_ids      := array_append(v_tr_instance_ids, p_instance_id);
      v_tr_from_states       := array_append(v_tr_from_states, v_prev_state);
      v_tr_to_states         := array_append(v_tr_to_states, v_snapshot->'value');
      v_tr_events            := array_append(v_tr_events, v_evt.payload->>'type');
      v_tr_timestamps        := array_append(v_tr_timestamps, v_now);
      v_tr_context_snapshots := array_append(v_tr_context_snapshots, v_snapshot->'context');
      v_prev_state := v_snapshot->'value';
    END IF;

    -- Update tracking fields from result
    v_wake_at      := (v_result->>'wakeAt')::BIGINT;
    v_wake_event   := v_result->'wakeEvent';
    v_fired_delays := COALESCE(v_result->'firedDelays', '[]'::JSONB);
    v_status       := COALESCE(v_result->>'status', 'running');
    v_cursor       := v_evt.seq;
  END LOOP;

  -- Step 7: Update machine_instances
  IF v_processed > 0 THEN
    UPDATE machine_instances SET
      state_value    = v_snapshot->'value',
      context        = v_snapshot->'context',
      status         = v_status,
      event_cursor   = v_cursor,
      wake_at        = v_wake_at,
      wake_event     = v_wake_event,
      fired_delays   = v_fired_delays,
      updated_at     = v_now
    WHERE id = p_instance_id;
  END IF;

  -- Step 8: Insert accumulated effects into effect_outbox (batch UNNEST)
  IF array_length(v_eff_instance_ids, 1) > 0 THEN
    INSERT INTO effect_outbox (instance_id, state_value, effect_type, effect_payload, max_attempts, created_at)
    SELECT * FROM UNNEST(
      v_eff_instance_ids,
      v_eff_state_values,
      v_eff_types,
      v_eff_payloads,
      v_eff_max_attempts,
      v_eff_created_ats
    );
  END IF;

  -- Step 9: Insert accumulated transitions into transition_log (batch UNNEST)
  IF array_length(v_tr_instance_ids, 1) > 0 THEN
    INSERT INTO transition_log (instance_id, from_state, to_state, event, ts, context_snapshot)
    SELECT * FROM UNNEST(
      v_tr_instance_ids,
      v_tr_from_states,
      v_tr_to_states,
      v_tr_events,
      v_tr_timestamps,
      v_tr_context_snapshots
    );
  END IF;

  -- Step 10: Return result
  RETURN jsonb_build_object('processed', v_processed, 'status', v_status, 'invocation', v_invocation);
END;
$$;
`;
