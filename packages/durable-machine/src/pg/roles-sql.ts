/**
 * SQL for creating PG roles and granting privileges.
 * Applied via store.ensureRoles(), NOT embedded in SCHEMA_SQL.
 *
 * Note: dm_app (LOGIN role) is provisioned externally as part of database
 * setup — it owns all tables and is the role the application connects as.
 * See spec Section 2.1 for the full role model.
 */
export const ROLES_SQL = `
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
`;

/** Data tables that get RLS policies. */
const RLS_TABLES = [
  "machine_instances",
  "event_log",
  "transition_log",
  "effect_outbox",
  "step_cache",
] as const;

/**
 * SQL for enabling RLS + FORCE RLS + tenant/admin policies on all data tables.
 * Includes explicit WITH CHECK for INSERT defense-in-depth.
 */
export const RLS_SQL = RLS_TABLES.map((table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = '${table}' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON ${table}
      FOR ALL TO dm_tenant
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = '${table}' AND policyname = 'admin_bypass'
  ) THEN
    CREATE POLICY admin_bypass ON ${table}
      FOR ALL TO dm_admin
      USING (true);
  END IF;
END $$;
`).join("\n");
