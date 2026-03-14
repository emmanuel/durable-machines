export const SCHEMA_SQL = `
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid
LANGUAGE sql VOLATILE
AS $uuidv7$
  SELECT (
    lpad(to_hex((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint), 12, '0')
    || '7'
    || substr(replace(gen_random_uuid()::text, '-', ''), 14)
  )::uuid;
$uuidv7$;

CREATE TABLE IF NOT EXISTS tenants (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  jwt_iss     TEXT NOT NULL,
  jwt_aud     TEXT NOT NULL,
  jwks_url    TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  UNIQUE (jwt_iss, jwt_aud)
);

CREATE TABLE IF NOT EXISTS machine_instances (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid REFERENCES tenants(id),
  machine_name    TEXT NOT NULL,
  state_value     JSONB NOT NULL,
  context         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',
  fired_delays    JSONB NOT NULL DEFAULT '[]',
  wake_at         BIGINT,
  wake_event      JSONB,
  input           JSONB,
  event_cursor    BIGINT NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
ALTER TABLE machine_instances ADD COLUMN IF NOT EXISTS wake_event JSONB;
CREATE INDEX IF NOT EXISTS idx_mi_status ON machine_instances (status);
CREATE INDEX IF NOT EXISTS idx_mi_wake ON machine_instances (wake_at) WHERE wake_at IS NOT NULL AND status = 'running';
CREATE INDEX IF NOT EXISTS idx_mi_name ON machine_instances (machine_name);
CREATE INDEX IF NOT EXISTS idx_mi_tenant ON machine_instances (tenant_id);

CREATE TABLE IF NOT EXISTS invoke_results (
  instance_id     UUID NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid,
  step_key        TEXT NOT NULL,
  output          JSONB,
  error           JSONB,
  started_at      BIGINT,
  completed_at    BIGINT,
  PRIMARY KEY (instance_id, step_key)
);
CREATE INDEX IF NOT EXISTS idx_ir_tenant ON invoke_results (tenant_id);

CREATE TABLE IF NOT EXISTS event_log (
  instance_id     UUID NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid,
  seq             BIGSERIAL,
  topic           TEXT NOT NULL DEFAULT 'event',
  payload         JSONB NOT NULL,
  source          TEXT,
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (instance_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_el_pending
  ON event_log (instance_id, seq);
CREATE INDEX IF NOT EXISTS idx_el_tenant ON event_log (tenant_id);

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
  instance_id     UUID NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid,
  seq             SERIAL,
  from_state      JSONB,
  to_state        JSONB NOT NULL,
  event           TEXT,
  ts              BIGINT NOT NULL,
  context_snapshot JSONB,
  PRIMARY KEY (instance_id, seq)
);
ALTER TABLE transition_log ADD COLUMN IF NOT EXISTS context_snapshot JSONB;
CREATE INDEX IF NOT EXISTS idx_tl_tenant ON transition_log (tenant_id);

CREATE TABLE IF NOT EXISTS effect_outbox (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  instance_id     UUID NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid,
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
CREATE INDEX IF NOT EXISTS idx_eo_tenant ON effect_outbox (tenant_id);

CREATE OR REPLACE FUNCTION effect_outbox_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('effect_pending', NEW.instance_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS effect_outbox_trigger ON effect_outbox;
CREATE TRIGGER effect_outbox_trigger
  AFTER INSERT ON effect_outbox FOR EACH ROW EXECUTE FUNCTION effect_outbox_notify();

CREATE OR REPLACE FUNCTION fire_due_timeouts() RETURNS INTEGER AS $$
DECLARE
  cnt INTEGER;
BEGIN
  WITH to_expire AS (
    SELECT id, tenant_id, wake_event FROM machine_instances
    WHERE wake_at <= (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      AND status = 'running' AND wake_at IS NOT NULL
    FOR UPDATE
  ),
  cleared AS (
    UPDATE machine_instances mi
    SET wake_at = NULL, wake_event = NULL
    FROM to_expire te
    WHERE mi.id = te.id
  )
  INSERT INTO event_log (instance_id, tenant_id, topic, payload, source, created_at)
  SELECT id, tenant_id, 'timeout', wake_event, 'system:timeout',
         (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  FROM to_expire
  WHERE wake_event IS NOT NULL;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END;
$$ LANGUAGE plpgsql;
`;
