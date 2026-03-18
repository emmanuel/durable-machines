# Multi-Tenancy Design

## Problem

durable-machines has no concept of tenancy. All machine instances, events, effects, and transitions are globally visible within a single database. There is no isolation between API consumers, no per-tenant JWT verification, and no row-level access control.

## Goals

- Isolate API consumers (tenants) so each sees only their own workflow data
- Enforce isolation at the PostgreSQL level via Row-Level Security (RLS)
- Admin endpoints see all data, tagged by tenant
- Tenant identity derived from JWT `iss` + `aud` claims, verified against per-tenant JWKS
- Minimize API surface changes; keep PgStore interface unchanged
- Do not extend DBOS backend; tenancy is a PG-backend concern
- Validate RLS policies in unit tests via PGlite (no Docker dependency)

## Non-Goals

- Per-tenant database or schema isolation
- DBOS backend multi-tenancy
- Tenant self-service registration (admin-provisioned for now)
- Rate limiting or usage metering per tenant

---

## 1. Schema Changes

### 1.1 UUIDv7 and TEXT → UUID Migration

All primary key and foreign key columns migrate from `TEXT` to `UUID` type. All ID defaults switch from `gen_random_uuid()` to time-ordered UUIDv7 for better index locality.

**PG function:**

```sql
CREATE FUNCTION uuidv7() RETURNS uuid
LANGUAGE sql VOLATILE
AS $$
  WITH raw AS (
    SELECT decode(lpad(to_hex(
      (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
    ), 12, '0'), 'hex') || gen_random_bytes(10) AS bytes
  ),
  versioned AS (
    SELECT set_byte(bytes, 6,
      (get_byte(bytes, 6) & x'0f'::int) | x'70'::int
    ) AS bytes FROM raw
  ),
  varianted AS (
    SELECT set_byte(bytes, 8,
      (get_byte(bytes, 8) & x'3f'::int) | x'80'::int
    ) AS bytes FROM versioned
  )
  SELECT encode(bytes, 'hex')::uuid FROM varianted;
$$;
```

A TypeScript `uuidv7()` function is also exported from `durable-machine` for caller-provided IDs (returns string).

**Type migration:** All existing `TEXT` primary keys and foreign keys are migrated to `UUID`:

- `machine_instances.id` — `TEXT` → `UUID` (caller-provided, no DB default)
- `effect_outbox.id` — `TEXT DEFAULT gen_random_uuid()` → `UUID DEFAULT uuidv7()`
- `event_log.instance_id`, `transition_log.instance_id`, `invoke_results.instance_id`, `effect_outbox.instance_id` — `TEXT` FK → `UUID` FK
- `event_log(instance_id, seq)`, `transition_log(instance_id, seq)`, `invoke_results(instance_id, step_key)` — composite PKs updated accordingly

The migration alters column types with `ALTER TABLE ... ALTER COLUMN ... TYPE UUID USING id::uuid`. Existing TEXT values that are valid UUIDs cast cleanly. The TypeScript `uuidv7()` returns a string, which the `pg` driver accepts for UUID columns.

### 1.2 Tenants Table

```sql
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  jwt_iss     TEXT NOT NULL,
  jwt_aud     TEXT NOT NULL,
  jwks_url    TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  UNIQUE (jwt_iss, jwt_aud)
);
```

Tenants are provisioned by admins. The `(jwt_iss, jwt_aud)` pair uniquely identifies a tenant. The `jwks_url` is used to fetch the JSON Web Key Set for verifying that tenant's JWTs.

### 1.3 tenant_id on Data Tables

Every data table (except `tenants` itself) gains a `NOT NULL` tenant_id column with a DEFAULT that auto-populates from the transaction-scoped GUC:

```sql
ALTER TABLE machine_instances
  ADD COLUMN tenant_id UUID NOT NULL
    DEFAULT current_setting('app.tenant_id', true)::uuid
    REFERENCES tenants(id);
```

The `current_setting('app.tenant_id', true)` form returns NULL (instead of erroring) when the GUC is not set. Combined with `NOT NULL`, an unscoped INSERT without an explicit `tenant_id` fails cleanly with a NOT NULL violation rather than a missing-setting error.

Tables with this column:

- `machine_instances`
- `event_log`
- `transition_log`
- `effect_outbox`
- `invoke_results`

Each table gets an index on `tenant_id`. The denormalization (vs. joining through `machine_instances`) enables direct RLS on every table, which is critical for hot-path queries like `claimPendingEffects` that scan `effect_outbox` globally.

Because the DEFAULT auto-populates `tenant_id` from the transaction GUC, **INSERT queries do not need an explicit `tenant_id` value**. When `forTenant()` sets the GUC, the DEFAULT fills in `tenant_id`. When unscoped code inserts (e.g., `fire_due_timeouts()`), it must explicitly propagate `tenant_id` from the source row (see Section 2.4).

**Note:** The TEXT → UUID migration does require updating type casts in UNNEST-based queries (`Q_INSERT_EFFECTS`, `Q_SEND_MACHINE_EVENT_BATCH`) from `$1::text[]` to `$1::uuid[]` for `instance_id` arrays. This is a mechanical consequence of the type migration, not a tenancy change.

### 1.4 Migration

This is a breaking change. Existing deployments must:

1. Create the `uuidv7()` PG function
2. Migrate all TEXT PK/FK columns to UUID (`ALTER COLUMN ... TYPE UUID USING col::uuid`)
3. Create the `tenants` table and insert a default tenant row
4. Add `tenant_id` column as nullable, backfill from the default tenant
5. Add the `NOT NULL` constraint and DEFAULT
6. Create roles and grant privileges
7. Enable RLS, `FORCE ROW LEVEL SECURITY`, and create policies

A migration script will be provided.

---

## 2. PostgreSQL Roles and RLS

### 2.1 Role Model

Three PostgreSQL roles:

- **`dm_app`** (LOGIN) — the role the application connects as. Owns all tables. Member of both `dm_tenant` and `dm_admin`.
- **`dm_tenant`** (NOLOGIN) — tenant-scoped access. RLS policies filter rows by `current_setting('app.tenant_id')`.
- **`dm_admin`** (NOLOGIN) — unscoped cross-tenant access. No RLS policies target this role.

```sql
CREATE ROLE dm_tenant NOLOGIN;
CREATE ROLE dm_admin  NOLOGIN;
CREATE ROLE dm_app    LOGIN PASSWORD '...' IN ROLE dm_tenant, dm_admin;

GRANT ALL ON ALL TABLES IN SCHEMA public TO dm_tenant, dm_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO dm_tenant, dm_admin;
```

**Default role behavior:** All data tables use `FORCE ROW LEVEL SECURITY`, so RLS applies even to the table owner (`dm_app`). This means `dm_app` is subject to RLS by default — an accidental unscoped query cannot leak cross-tenant data.

- **`dm_app` (default)** — subject to RLS. Since `dm_app` has no matching policy (policies target `dm_tenant`), unscoped queries return zero rows. This is a safety net.
- **`SET LOCAL ROLE dm_tenant`** — activates tenant-scoped RLS. Used by `forTenant()`.
- **`SET LOCAL ROLE dm_admin`** — bypasses RLS (no policies target `dm_admin`). Used by workers and admin endpoints.

Workers and admin endpoints must explicitly `SET LOCAL ROLE dm_admin` in their transactions to access data across tenants.

### 2.2 RLS Policies

RLS is enabled on all data tables. A single policy per table targets `dm_tenant`:

```sql
ALTER TABLE machine_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_instances FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON machine_instances
  FOR ALL TO dm_tenant
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY admin_bypass ON machine_instances
  FOR ALL TO dm_admin
  USING (true);
```

The same pattern applies to `event_log`, `transition_log`, `effect_outbox`, and `invoke_results`.

`FORCE ROW LEVEL SECURITY` ensures even the table owner (`dm_app`) is subject to RLS. `dm_admin` has an explicit `USING (true)` policy granting full access. `dm_app` has no policy — unscoped queries return zero rows by default, preventing accidental data leaks.

### 2.3 Tenant Scope Setup

Tenant scoping is done with two plain SQL statements issued by the application at the start of each transaction — no PG function needed:

```sql
SET LOCAL ROLE dm_tenant;
SELECT set_config('app.tenant_id', $1::text, true);
```

`SET LOCAL ROLE` requires `EXECUTE` in PL/pgSQL (it's a command, not a function call), so wrapping these in a PG function would force PL/pgSQL. Issuing them directly from the app layer keeps everything in plain SQL and avoids the PL/pgSQL dependency.

`set_config('app.tenant_id', ..., true)` scopes the custom GUC to the current transaction. On `COMMIT` or `ROLLBACK`, both settings reset automatically.

### 2.4 Stored Functions

The `fire_due_timeouts()` function inserts into `event_log` from `machine_instances`. It must propagate `tenant_id`:

```sql
INSERT INTO event_log (instance_id, tenant_id, topic, payload, source, created_at)
SELECT id, tenant_id, 'timeout', wake_event, 'system:timeout', ...
FROM to_expire
WHERE wake_event IS NOT NULL;
```

The `event_log_notify()` and `effect_outbox_notify()` trigger functions do not insert rows, so they need no `tenant_id` propagation changes. Note: `event_log_notify()` performs `SELECT machine_name FROM machine_instances WHERE id = NEW.instance_id` — under `FORCE RLS`, this SELECT is subject to the caller's role. It works correctly in both contexts: under `dm_admin` (admin_bypass policy applies) and under `dm_tenant` (the instance belongs to the scoped tenant).

---

## 3. Store Integration

### 3.1 PgStore Interface

The existing `PgStore` method signatures are unchanged. No new parameters on existing methods. The `tenant_id` column DEFAULT auto-populates from the transaction GUC, so INSERT queries do not need an explicit `tenant_id` value. UNNEST-based queries need type cast updates (`text[]` → `uuid[]`) as part of the UUID migration. DBOS backend is unaffected.

**Type changes:** `MachineRow` gains a `tenantId` field (mapped from the `tenant_id` column). This is a return-type change visible to consumers, but method signatures remain the same.

### 3.2 forTenant()

The PG store gains one new method (PG-specific, not on the shared interface):

```ts
store.forTenant(tenantId: string): PgStore
```

Returns a `PgStore` where every operation is wrapped in a scoped transaction:

```sql
BEGIN;
SET LOCAL ROLE dm_tenant;
SELECT set_config('app.tenant_id', $1::text, true);
<actual query>
COMMIT;
```

Implementation approach: `forTenant()` returns a store backed by a **proxy pool** that intercepts all `pool.query()` and `pool.connect()` calls, wrapping each in a scoped transaction. This avoids modifying each of the 15+ individual store methods and automatically handles future methods.

- Methods that already use `withTransaction` (e.g., `finalizeInstance`) — the proxy injects the two scope statements after `BEGIN`.
- Methods that call `pool.query()` directly (e.g., `getInstance`, `listInstances`, `appendEvent`, analytics methods) — the proxy wraps them in a short transaction with the scope set.

The standalone client functions (`sendMachineEvent`, `sendMachineEventBatch`, `getMachineState` in `client.ts`) accept a `Pool` parameter. Passing the proxy pool from `forTenant()` scopes these calls as well — no changes to the client function signatures needed.

### 3.3 Unscoped Access

Because `FORCE ROW LEVEL SECURITY` is set, the base store must explicitly assume `dm_admin` to bypass RLS. The base `createStore()` wraps all operations with `SET LOCAL ROLE dm_admin` — the inverse of `forTenant()`. Used by:

- **Admin endpoints** — list/inspect all data with `tenant_id` as visible metadata
- **Worker pollers** — `fire_due_timeouts()`, `claimPendingEffects()` scan all tenants

Both `forTenant()` and the base store wrap queries in short transactions with the appropriate `SET LOCAL ROLE`. The difference is which role: `dm_tenant` (scoped) vs `dm_admin` (unscoped).

### 3.4 Worker tenant_id Propagation

The event processor runs under `dm_admin` (unscoped) but performs INSERTs into `event_log`, `transition_log`, `effect_outbox`, and `invoke_results`. These tables have `tenant_id NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid`. Without the GUC set, the DEFAULT returns NULL and the NOT NULL constraint fails.

**Solution:** When the worker locks an instance row (via `lockAndGetInstance`), it reads the `tenant_id` from that row. Before processing events for that instance, it sets `SET LOCAL app.tenant_id = <locked_row.tenant_id>`. This ensures all INSERTs during event processing inherit the correct `tenant_id` via the column DEFAULT.

The worker does NOT switch to `dm_tenant` — it stays as `dm_admin` (bypassing RLS) but sets the GUC so DEFAULTs work. This means the worker can still read/write across tenants but INSERTs get the correct `tenant_id`.

This applies to:
- `finalizeInstance` / `finalizeWithTransition` (CTE inserts into `transition_log`)
- `appendEvent` / `appendTransition`
- `insertEffects`
- `recordInvokeResult`

---

## 4. Gateway Integration

### 4.1 JWT Tenant Resolution

Tenant-scoped REST routes use middleware that:

1. Decodes the JWT (without verifying) to extract `iss` and `aud` claims
2. Looks up `SELECT id, jwks_url FROM tenants WHERE jwt_iss = $1 AND jwt_aud = $2`
3. If not found → 401
4. Fetches JWKS from `jwks_url` (cached with TTL) and verifies the JWT signature
5. If invalid → 401
6. Attaches `tenantId` to the Hono request context
7. Downstream handlers use `store.forTenant(c.get("tenantId"))`

JWKS responses are cached with a configurable TTL (default: 1 hour). On cache miss or verification failure with a cached key, the JWKS is re-fetched once to handle key rotation.

### 4.2 Admin Endpoints

Admin routes are a separate Hono app or route group with independent auth (not JWT-tenant-based). They use the unscoped store and return data with `tenant_id` visible as a field on every response object.

### 4.3 Dashboard

The dashboard currently shows all data globally. With tenancy:

- **Tenant-scoped dashboard** — uses `forTenant()`, shows only that tenant's data
- **Admin dashboard** — uses unscoped store, shows all data tagged by tenant

Which dashboard mode is active depends on the auth middleware attached.

---

## 5. Webhook Tenancy

### 5.1 Per-Tenant Bindings

Each tenant gets its own unique webhook path. The path itself identifies the tenant — no path-grouping or verify-based matching needed:

```ts
gateway.registerWebhook({
  tenantId: "tenant-abc",
  path: "/webhooks/tenant-abc/stripe",  // unique per tenant
  source: stripeSource({ signingSecret: tenantStripeSecret }),
  router: fieldRouter((payload) => payload.workflowId),
  transform: stripeTransform,
});
```

### 5.2 Tenant Routing via Path

Each `WebhookBinding` registers its own `app.post(path, ...)` route — same as the current architecture. Because paths are unique per tenant, there is no ambiguity:

1. Webhook hits `/webhooks/tenant-abc/stripe`
2. The route handler for that path fires
3. The binding's `source.verify()` validates the request signature
4. The binding's `router` and `transform` are applied
5. Event is sent via `forTenantClient(binding.tenantId)`

If verification fails → 401.

The `WebhookBinding` type gains a `tenantId` field, and `GatewayOptions` gains a `forTenantClient` function. When a binding has a `tenantId`, the gateway uses `forTenantClient(binding.tenantId)` instead of the default client for dispatching events.

---

## 6. Testing

### 6.1 RLS Tests with PGlite

PGlite supports `CREATE ROLE`, `SET ROLE`, `GRANT`, and RLS policies (verified experimentally). RLS policies are validated in unit tests using the PGlite adapter (no Docker):

```ts
beforeAll(async () => {
  const db = new PGlite();
  const pool = createPgLitePool(db);
  await pool.query(ROLE_AND_POLICY_SQL);
  const store = createStore({ pool, useListenNotify: false });
  await store.ensureSchema();
});
```

Test cases:

- Tenant A cannot see tenant B's instances
- Tenant A cannot see tenant B's events, transitions, effects
- Cross-tenant insert is rejected by RLS policy
- dm_app with no SET ROLE sees zero rows (FORCE RLS safety net)
- Unscoped store (dm_admin) sees all rows across tenants
- forTenant() correctly scopes all store operations
- tenant_id DEFAULT auto-populates from GUC on INSERT

### 6.2 Integration Tests

Integration tests against Docker PG verify:

- Role creation and privilege grants work
- SET LOCAL ROLE + SET LOCAL app.tenant_id scoping per transaction
- Connection pool behavior with role switching
- JWKS verification flow (mocked JWKS endpoint)

---

## 7. Summary

| Component | Change |
|-----------|--------|
| **Schema** | `tenants` table; `tenant_id` column with GUC-based DEFAULT on all data tables; all PKs/FKs migrated TEXT → UUID; UUIDv7 everywhere |
| **PG roles** | `dm_app` (login, table owner, subject to FORCE RLS) → assumes `dm_tenant` (scoped) or `dm_admin` (unscoped) |
| **RLS** | FORCE RLS on all tables; `dm_tenant` filtered by `current_setting('app.tenant_id')`; `dm_admin` bypasses via `USING (true)` |
| **Store** | `forTenant(id)` returns scoped PgStore (dm_tenant); base store uses dm_admin; interface otherwise unchanged; no query changes |
| **Gateway** | JWT middleware resolves tenant via `(iss, aud)` → verifies via `jwks_url` with cached JWKS |
| **Webhooks** | Per-tenant bindings; signing secret verification identifies tenant |
| **Admin** | Separate endpoints, unscoped store (dm_admin), data tagged by tenant_id |
| **Testing** | RLS validated in PGlite unit tests; full flow in integration tests |
| **DBOS** | Unchanged |
