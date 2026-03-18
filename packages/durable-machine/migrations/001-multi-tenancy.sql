-- 001-multi-tenancy.sql
--
-- Migrates an existing durable-machines schema (TEXT PKs) to
-- multi-tenant UUID-based schema with RLS.
--
-- Prerequisites:
--   - pgcrypto extension (for gen_random_uuid)
--   - Application connects as a role that owns the tables (dm_app)
--
-- This migration:
--   1. Creates the uuidv7() function
--   2. Creates the tenants table
--   3. Creates a default tenant for existing data
--   4. Converts TEXT PKs/FKs to UUID
--   5. Adds tenant_id columns with FK to tenants
--   6. Creates dm_tenant and dm_admin roles with RLS
--
-- Run inside a transaction: BEGIN; \i 001-multi-tenancy.sql; COMMIT;

-- ── 1. UUIDv7 function ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid
LANGUAGE sql VOLATILE
AS $uuidv7$
  SELECT (
    lpad(to_hex((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint), 12, '0')
    || '7'
    || substr(replace(gen_random_uuid()::text, '-', ''), 14)
  )::uuid;
$uuidv7$;

-- ── 2. Tenants table ────────────────────────────────────────────────────────

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

-- ── 3. Default tenant for existing data ─────────────────────────────────────

INSERT INTO tenants (id, jwt_iss, jwt_aud, jwks_url, name, created_at, updated_at)
VALUES (
  uuidv7(),
  'urn:durable-machines:default',
  'urn:durable-machines:default',
  'https://example.com/.well-known/jwks.json',
  'default',
  EXTRACT(EPOCH FROM NOW())::bigint * 1000,
  EXTRACT(EPOCH FROM NOW())::bigint * 1000
)
ON CONFLICT (jwt_iss, jwt_aud) DO NOTHING;

-- ── 4. Convert TEXT PKs to UUID ─────────────────────────────────────────────

-- Drop FKs first (they reference machine_instances.id)
ALTER TABLE event_log       DROP CONSTRAINT IF EXISTS event_log_instance_id_fkey;
ALTER TABLE transition_log  DROP CONSTRAINT IF EXISTS transition_log_instance_id_fkey;
ALTER TABLE effect_outbox   DROP CONSTRAINT IF EXISTS effect_outbox_instance_id_fkey;
ALTER TABLE step_cache  DROP CONSTRAINT IF EXISTS step_cache_instance_id_fkey;

-- Convert machine_instances.id from TEXT to UUID
ALTER TABLE machine_instances
  ALTER COLUMN id TYPE UUID USING id::uuid;

-- Convert FK columns in child tables
ALTER TABLE event_log
  ALTER COLUMN instance_id TYPE UUID USING instance_id::uuid;

ALTER TABLE transition_log
  ALTER COLUMN instance_id TYPE UUID USING instance_id::uuid;

ALTER TABLE effect_outbox
  ALTER COLUMN instance_id TYPE UUID USING instance_id::uuid;

-- Convert effect_outbox.id from TEXT to UUID (if it was TEXT)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'effect_outbox' AND column_name = 'id'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE effect_outbox ALTER COLUMN id TYPE UUID USING id::uuid;
    ALTER TABLE effect_outbox ALTER COLUMN id SET DEFAULT uuidv7();
  END IF;
END $$;

ALTER TABLE step_cache
  ALTER COLUMN instance_id TYPE UUID USING instance_id::uuid;

-- Re-add FKs with CASCADE
ALTER TABLE event_log
  ADD CONSTRAINT event_log_instance_id_fkey
  FOREIGN KEY (instance_id) REFERENCES machine_instances(id) ON DELETE CASCADE;

ALTER TABLE transition_log
  ADD CONSTRAINT transition_log_instance_id_fkey
  FOREIGN KEY (instance_id) REFERENCES machine_instances(id) ON DELETE CASCADE;

ALTER TABLE effect_outbox
  ADD CONSTRAINT effect_outbox_instance_id_fkey
  FOREIGN KEY (instance_id) REFERENCES machine_instances(id) ON DELETE CASCADE;

ALTER TABLE step_cache
  ADD CONSTRAINT step_cache_instance_id_fkey
  FOREIGN KEY (instance_id) REFERENCES machine_instances(id) ON DELETE CASCADE;

-- ── 5. Add tenant_id columns ────────────────────────────────────────────────

-- Get the default tenant ID
DO $$
DECLARE
  default_tid UUID;
BEGIN
  SELECT id INTO default_tid FROM tenants WHERE name = 'default' LIMIT 1;

  -- machine_instances
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'machine_instances' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE machine_instances ADD COLUMN tenant_id UUID;
    UPDATE machine_instances SET tenant_id = default_tid WHERE tenant_id IS NULL;
    ALTER TABLE machine_instances ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE machine_instances ALTER COLUMN tenant_id
      SET DEFAULT current_setting('app.tenant_id', true)::uuid;
    ALTER TABLE machine_instances
      ADD CONSTRAINT machine_instances_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenants(id);
  END IF;

  -- event_log
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'event_log' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE event_log ADD COLUMN tenant_id UUID;
    UPDATE event_log e SET tenant_id = (
      SELECT tenant_id FROM machine_instances m WHERE m.id = e.instance_id
    );
    ALTER TABLE event_log ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE event_log ALTER COLUMN tenant_id
      SET DEFAULT current_setting('app.tenant_id', true)::uuid;
  END IF;

  -- transition_log
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'transition_log' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE transition_log ADD COLUMN tenant_id UUID;
    UPDATE transition_log t SET tenant_id = (
      SELECT tenant_id FROM machine_instances m WHERE m.id = t.instance_id
    );
    ALTER TABLE transition_log ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE transition_log ALTER COLUMN tenant_id
      SET DEFAULT current_setting('app.tenant_id', true)::uuid;
  END IF;

  -- effect_outbox
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'effect_outbox' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE effect_outbox ADD COLUMN tenant_id UUID;
    UPDATE effect_outbox e SET tenant_id = (
      SELECT tenant_id FROM machine_instances m WHERE m.id = e.instance_id
    );
    ALTER TABLE effect_outbox ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE effect_outbox ALTER COLUMN tenant_id
      SET DEFAULT current_setting('app.tenant_id', true)::uuid;
  END IF;

  -- step_cache
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'step_cache' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE step_cache ADD COLUMN tenant_id UUID;
    UPDATE step_cache r SET tenant_id = (
      SELECT tenant_id FROM machine_instances m WHERE m.id = r.instance_id
    );
    ALTER TABLE step_cache ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE step_cache ALTER COLUMN tenant_id
      SET DEFAULT current_setting('app.tenant_id', true)::uuid;
  END IF;
END $$;

-- ── 6. Add tenant_id indexes ────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_mi_tenant ON machine_instances (tenant_id);
CREATE INDEX IF NOT EXISTS idx_el_tenant ON event_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tl_tenant ON transition_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_eo_tenant ON effect_outbox (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ir_tenant ON step_cache (tenant_id);

-- ── 7. Roles and RLS ───────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dm_tenant') THEN
    CREATE ROLE dm_tenant NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dm_admin') THEN
    CREATE ROLE dm_admin NOLOGIN;
  END IF;
END $$;

GRANT ALL ON ALL TABLES IN SCHEMA public TO dm_tenant, dm_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dm_tenant, dm_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO dm_tenant, dm_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dm_tenant, dm_admin;

-- RLS policies on all data tables
DO $$ BEGIN
  -- machine_instances
  ALTER TABLE machine_instances ENABLE ROW LEVEL SECURITY;
  ALTER TABLE machine_instances FORCE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'machine_instances' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON machine_instances FOR ALL TO dm_tenant
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'machine_instances' AND policyname = 'admin_bypass') THEN
    CREATE POLICY admin_bypass ON machine_instances FOR ALL TO dm_admin USING (true);
  END IF;

  -- event_log
  ALTER TABLE event_log ENABLE ROW LEVEL SECURITY;
  ALTER TABLE event_log FORCE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_log' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON event_log FOR ALL TO dm_tenant
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_log' AND policyname = 'admin_bypass') THEN
    CREATE POLICY admin_bypass ON event_log FOR ALL TO dm_admin USING (true);
  END IF;

  -- transition_log
  ALTER TABLE transition_log ENABLE ROW LEVEL SECURITY;
  ALTER TABLE transition_log FORCE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'transition_log' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON transition_log FOR ALL TO dm_tenant
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'transition_log' AND policyname = 'admin_bypass') THEN
    CREATE POLICY admin_bypass ON transition_log FOR ALL TO dm_admin USING (true);
  END IF;

  -- effect_outbox
  ALTER TABLE effect_outbox ENABLE ROW LEVEL SECURITY;
  ALTER TABLE effect_outbox FORCE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'effect_outbox' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON effect_outbox FOR ALL TO dm_tenant
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'effect_outbox' AND policyname = 'admin_bypass') THEN
    CREATE POLICY admin_bypass ON effect_outbox FOR ALL TO dm_admin USING (true);
  END IF;

  -- step_cache
  ALTER TABLE step_cache ENABLE ROW LEVEL SECURITY;
  ALTER TABLE step_cache FORCE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'step_cache' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON step_cache FOR ALL TO dm_tenant
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'step_cache' AND policyname = 'admin_bypass') THEN
    CREATE POLICY admin_bypass ON step_cache FOR ALL TO dm_admin USING (true);
  END IF;
END $$;

-- ── 8. Update trigger functions for UUID cast ───────────────────────────────

CREATE OR REPLACE FUNCTION event_log_notify() RETURNS trigger AS $$
DECLARE
  m_name TEXT;
BEGIN
  SELECT machine_name INTO m_name FROM machine_instances WHERE id = NEW.instance_id;
  PERFORM pg_notify('machine_event', m_name || '::' || NEW.instance_id::text || '::' || NEW.topic);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION effect_outbox_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('effect_pending', NEW.instance_id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 9. Idempotency key for event dedup ────────────────────────────────────────

ALTER TABLE event_log ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_el_idempotency
  ON event_log (instance_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
