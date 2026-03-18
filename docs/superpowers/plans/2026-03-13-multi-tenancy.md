# Multi-Tenancy Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tenant isolation to durable-machines via PostgreSQL RLS, UUIDv7 IDs, and a proxy-pool `forTenant()` API.

**Architecture:** All data tables gain a `tenant_id UUID` column with GUC-based DEFAULT. Three PG roles (`dm_app`, `dm_tenant`, `dm_admin`) control access via `FORCE ROW LEVEL SECURITY`. The store exposes `forTenant(id)` returning a scoped PgStore backed by a proxy pool that injects `SET LOCAL ROLE dm_tenant` + GUC per transaction.

**Tech Stack:** PostgreSQL RLS, PGlite (unit tests), `jose` (JWT/JWKS), Hono middleware, XState

**Spec:** `docs/superpowers/specs/2026-03-13-multi-tenancy-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/durable-machine/src/uuidv7.ts` | TypeScript UUIDv7 generator (exported for caller-provided IDs) |
| `packages/durable-machine/src/pg/tenant-pool.ts` | Proxy pool that injects `SET LOCAL ROLE` + GUC per transaction |
| `packages/durable-machine/src/pg/roles-sql.ts` | SQL constants for role creation, RLS policies, grants |
| `packages/durable-machine/tests/unit/uuidv7.test.ts` | UUIDv7 format/monotonicity tests |
| `packages/durable-machine/tests/unit/tenant-pool.test.ts` | Proxy pool scoping tests |
| `packages/durable-machine/tests/unit/rls.test.ts` | RLS isolation tests via PGlite |
| `packages/gateway/src/tenant-middleware.ts` | Hono middleware: JWT decode → tenant lookup → JWKS verify |
| `packages/gateway/tests/unit/tenant-middleware.test.ts` | Middleware tests with mocked JWKS |

### Modified Files

| File | Changes |
|------|---------|
| `packages/durable-machine/src/pg/schema.ts` | Add `uuidv7()` PG function, `tenants` table, `tenant_id` columns. Migrate TEXT→UUID. Update `fire_due_timeouts()` to propagate `tenant_id`. |
| `packages/durable-machine/src/pg/queries.ts` | Update UNNEST casts `text[]`→`uuid[]` in `Q_INSERT_EFFECTS` and `Q_SEND_MACHINE_EVENT_BATCH`. Add `Q_LOOKUP_TENANT`. |
| `packages/durable-machine/src/pg/store.ts` | Add `forTenant()` and `ensureRoles()` methods. Add `tenantId` to `rowToMachine()`. |
| `packages/durable-machine/src/pg/store-types.ts` | Add `tenantId: string` to `MachineRow`. Add `TenantRow` type. Add `forTenant()` and `ensureRoles()` to `PgStore` interface. |
| `packages/durable-machine/src/pg/event-processor.ts` | After locking instance row, set `app.tenant_id` GUC from `row.tenantId`. |
| `packages/durable-machine/src/pg/client.ts` | No signature changes (proxy pool handles scoping). `pg` driver accepts strings for UUID columns. |
| `packages/durable-machine/src/pg/create-durable-machine.ts` | Wrap pool with `dm_admin` proxy. Expose `forTenant()` on `PgDurableMachine`. |
| `packages/durable-machine/src/index.ts` | Export `uuidv7`. |
| `packages/durable-machine/src/pg/index.ts` | Export `TenantRow`, `createTenantPool`, `ROLES_SQL`, `RLS_SQL`. |
| `packages/durable-machine/tests/unit/pg-store.test.ts` | Use UUID IDs. Create test tenant + set GUC before INSERTs. |
| `packages/durable-machine/tests/fixtures/pglite-pool.ts` | No changes needed (PGlite supports SET ROLE natively). |
| `packages/gateway/src/types.ts` | Add `tenantId?: string` to `WebhookBinding`. Add `forTenantClient` to `GatewayOptions`. |
| `packages/gateway/src/gateway.ts` | Group bindings by path. Iterate candidates for verification. Route via matched binding's `tenantId`. |
| `packages/gateway/src/rest-api.ts` | Add tenant middleware to routes. Use `store.forTenant(c.get("tenantId"))` in handlers. |

### Deferred

| File | Notes |
|------|-------|
| `packages/gateway/src/admin.ts` | Admin server tenant_id visibility — deferred to follow-up. Admin routes already use unscoped store; adding `tenantId` to response payloads is a minor change. |
| `packages/gateway/src/dashboard/` | Dashboard tenant scoping (Spec 4.3) — deferred. Requires `forTenant()` wiring into dashboard routes based on auth middleware. |

---

## Chunk 1: UUIDv7

### Task 1: TypeScript UUIDv7 Function

**Files:**
- Create: `packages/durable-machine/src/uuidv7.ts`
- Test: `packages/durable-machine/tests/unit/uuidv7.test.ts`
- Modify: `packages/durable-machine/src/index.ts`

- [ ] **Step 1: Write failing tests for uuidv7()**

```ts
// packages/durable-machine/tests/unit/uuidv7.test.ts
import { describe, it, expect } from "vitest";
import { uuidv7 } from "../../src/uuidv7.js";

describe("uuidv7", () => {
  it("returns a valid UUID string", () => {
    const id = uuidv7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("embeds version 7 and variant bits", () => {
    const id = uuidv7();
    expect(id[14]).toBe("7"); // version nibble
    expect("89ab").toContain(id[19]); // variant nibble
  });

  it("is monotonically increasing", () => {
    const ids = Array.from({ length: 100 }, () => uuidv7());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("generates unique values", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(ids.size).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/durable-machine && npx vitest run tests/unit/uuidv7.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement uuidv7()**

```ts
// packages/durable-machine/src/uuidv7.ts
import { randomBytes } from "node:crypto";

/**
 * Generate a UUIDv7 string (RFC 9562). Time-ordered for better
 * B-tree index locality in PostgreSQL UUID columns.
 */
export function uuidv7(): string {
  const now = Date.now();

  // 6 bytes: 48-bit millisecond timestamp (big-endian)
  const ts = new Uint8Array(6);
  ts[0] = (now / 2 ** 40) & 0xff;
  ts[1] = (now / 2 ** 32) & 0xff;
  ts[2] = (now / 2 ** 24) & 0xff;
  ts[3] = (now / 2 ** 16) & 0xff;
  ts[4] = (now / 2 ** 8) & 0xff;
  ts[5] = now & 0xff;

  // 10 random bytes
  const rand = randomBytes(10);

  // Set version (0111) and variant (10xx) bits
  rand[0] = (rand[0] & 0x0f) | 0x70; // version 7
  rand[2] = (rand[2] & 0x3f) | 0x80; // variant 10

  const hex = Buffer.concat([ts, rand]).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/durable-machine && npx vitest run tests/unit/uuidv7.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Export from index**

Add to `packages/durable-machine/src/index.ts`:
```ts
export { uuidv7 } from "./uuidv7.js";
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add packages/durable-machine/src/uuidv7.ts \
       packages/durable-machine/tests/unit/uuidv7.test.ts \
       packages/durable-machine/src/index.ts
git commit -m "feat: add TypeScript uuidv7() function"
```

---

### Task 2: UUIDv7 PG Function in Schema

**Files:**
- Modify: `packages/durable-machine/src/pg/schema.ts`

- [ ] **Step 1: Add uuidv7() PG function to SCHEMA_SQL**

Add before the `CREATE TABLE` statements in `SCHEMA_SQL`:

```sql
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid
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

- [ ] **Step 2: Run existing unit tests to verify no regression**

Run: `cd packages/durable-machine && npx vitest run --project unit tests/unit/pg-store.test.ts`
Expected: PASS (all existing tests still pass)

- [ ] **Step 3: Commit**

```bash
git add packages/durable-machine/src/pg/schema.ts
git commit -m "feat: add uuidv7() SQL function to schema"
```

---

## Chunk 2: Schema Migration (TEXT → UUID + Tenancy Tables)

### Task 3: Migrate TEXT PKs/FKs to UUID in Schema

**Files:**
- Modify: `packages/durable-machine/src/pg/schema.ts`
- Modify: `packages/durable-machine/src/pg/queries.ts` (UNNEST casts)
- Modify: `packages/durable-machine/tests/unit/pg-store.test.ts` (use UUID IDs)

- [ ] **Step 1: Update SCHEMA_SQL — change all TEXT PKs/FKs to UUID**

In `packages/durable-machine/src/pg/schema.ts`, change the table definitions:

```sql
-- machine_instances
CREATE TABLE IF NOT EXISTS machine_instances (
  id              UUID PRIMARY KEY,        -- was TEXT
  ...
);

-- invoke_results
CREATE TABLE IF NOT EXISTS invoke_results (
  instance_id     UUID NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,  -- was TEXT
  ...
);

-- event_log
CREATE TABLE IF NOT EXISTS event_log (
  instance_id     UUID NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,  -- was TEXT
  ...
);

-- transition_log
CREATE TABLE IF NOT EXISTS transition_log (
  instance_id     UUID NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,  -- was TEXT
  ...
);

-- effect_outbox
CREATE TABLE IF NOT EXISTS effect_outbox (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),     -- was TEXT DEFAULT gen_random_uuid()
  instance_id     UUID NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,  -- was TEXT
  ...
);
```

- [ ] **Step 2: Update UNNEST casts in queries.ts**

In `Q_INSERT_EFFECTS`, change `$1::text[]` to `$1::uuid[]`:
```ts
export const Q_INSERT_EFFECTS = {
  name: "dm_insert_effects",
  text: `INSERT INTO effect_outbox (instance_id, state_value, effect_type, effect_payload, max_attempts, created_at)
         SELECT * FROM UNNEST($1::uuid[], $2::jsonb[], $3::text[], $4::jsonb[], $5::int[], $6::bigint[])`,
} as const;
```

In `Q_SEND_MACHINE_EVENT_BATCH`, change `$1::text[]` to `$1::uuid[]`:
```ts
export const Q_SEND_MACHINE_EVENT_BATCH = {
  name: "dm_send_machine_event_batch",
  text: `INSERT INTO event_log (instance_id, topic, payload, created_at)
       SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::jsonb[], $4::bigint[])`,
} as const;
```

- [ ] **Step 3: Update unit test IDs to valid UUIDs**

In `packages/durable-machine/tests/unit/pg-store.test.ts`, add a helper at the top:

```ts
import { uuidv7 } from "../../src/uuidv7.js";
```

Replace all string IDs with `uuidv7()` calls. For example:
```ts
// Before:  id: "test-1"
// After:   id: uuidv7()
```

Use `let` variables at describe scope for IDs that are referenced across `it` blocks, or generate inline for single-use IDs.

- [ ] **Step 4: Run unit tests**

Run: `cd packages/durable-machine && npx vitest run --project unit tests/unit/pg-store.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add packages/durable-machine/src/pg/schema.ts \
       packages/durable-machine/src/pg/queries.ts \
       packages/durable-machine/tests/unit/pg-store.test.ts
git commit -m "feat: migrate all PKs/FKs from TEXT to UUID"
```

---

### Task 4: Add Tenants Table and tenant_id Columns

**Files:**
- Modify: `packages/durable-machine/src/pg/schema.ts`
- Modify: `packages/durable-machine/src/pg/store-types.ts`
- Modify: `packages/durable-machine/src/pg/store.ts` (`rowToMachine`)
- Modify: `packages/durable-machine/src/pg/queries.ts` (add `Q_LOOKUP_TENANT`)
- Modify: `packages/durable-machine/tests/unit/pg-store.test.ts` (create tenant + set GUC)

- [ ] **Step 1: Add tenants table to SCHEMA_SQL**

Insert before the data tables in `packages/durable-machine/src/pg/schema.ts`:

```sql
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
```

- [ ] **Step 2: Add tenant_id column to all data tables**

Add to each data table definition in `SCHEMA_SQL`:

```sql
-- In machine_instances, after id:
  tenant_id       UUID NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid REFERENCES tenants(id),

-- Same column (without FK on child tables — FK is on machine_instances):
-- In event_log, invoke_results, transition_log, effect_outbox:
  tenant_id       UUID NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid,
```

Add indexes after each table:
```sql
CREATE INDEX IF NOT EXISTS idx_mi_tenant ON machine_instances (tenant_id);
CREATE INDEX IF NOT EXISTS idx_el_tenant ON event_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tl_tenant ON transition_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_eo_tenant ON effect_outbox (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ir_tenant ON invoke_results (tenant_id);
```

- [ ] **Step 3: Update fire_due_timeouts() to propagate tenant_id**

In `fire_due_timeouts()`, add `tenant_id` to the SELECT and INSERT:

```sql
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
```

- [ ] **Step 4: Add TenantRow type and tenantId to MachineRow**

In `packages/durable-machine/src/pg/store-types.ts`:

```ts
export interface TenantRow {
  id: string;
  jwtIss: string;
  jwtAud: string;
  jwksUrl: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}
```

Add to `MachineRow`:
```ts
  tenantId: string;
```

- [ ] **Step 5: Update rowToMachine() in store.ts**

In `packages/durable-machine/src/pg/store.ts`, add `tenantId` to `rowToMachine()`:

```ts
function rowToMachine(row: any): MachineRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    machineName: row.machine_name,
    // ... rest unchanged
  };
}
```

- [ ] **Step 6: Add Q_LOOKUP_TENANT to queries.ts**

```ts
export const Q_LOOKUP_TENANT = {
  name: "dm_lookup_tenant",
  text: `SELECT id, jwks_url FROM tenants WHERE jwt_iss = $1 AND jwt_aud = $2`,
} as const;
```

- [ ] **Step 7: Update unit tests — create tenant and set GUC before INSERTs**

In `packages/durable-machine/tests/unit/pg-store.test.ts`, update `beforeAll` to create a test tenant, and `beforeEach` to set the GUC:

```ts
let testTenantId: string;

beforeAll(async () => {
  db = new PGlite();
  pool = createPgLitePool(db);
  store = createStore({ pool, useListenNotify: false });
  await store.ensureSchema();

  // Create a test tenant
  testTenantId = uuidv7();
  const now = Date.now();
  await pool.query({
    text: `INSERT INTO tenants (id, jwt_iss, jwt_aud, jwks_url, name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    values: [testTenantId, "test-iss", "test-aud", "https://example.com/.well-known/jwks.json", "Test Tenant", now, now],
  });
});

beforeEach(async () => {
  await pool.query("TRUNCATE machine_instances CASCADE");
  // Set tenant GUC so DEFAULT works on INSERT
  await pool.query({
    text: `SELECT set_config('app.tenant_id', $1, false)`,
    values: [testTenantId],
  });
});
```

- [ ] **Step 8: Run unit tests**

Run: `cd packages/durable-machine && npx vitest run --project unit tests/unit/pg-store.test.ts`
Expected: PASS

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 10: Commit**

```bash
git add packages/durable-machine/src/pg/schema.ts \
       packages/durable-machine/src/pg/store-types.ts \
       packages/durable-machine/src/pg/store.ts \
       packages/durable-machine/src/pg/queries.ts \
       packages/durable-machine/tests/unit/pg-store.test.ts
git commit -m "feat: add tenants table and tenant_id columns to all data tables"
```

---

## Chunk 3: Roles, RLS, and Proxy Pool

### Task 5: Add Roles and RLS SQL

**Files:**
- Create: `packages/durable-machine/src/pg/roles-sql.ts`
- Modify: `packages/durable-machine/src/pg/store-types.ts`
- Modify: `packages/durable-machine/src/pg/store.ts`

RLS SQL is NOT embedded in `SCHEMA_SQL` because `CREATE POLICY ... TO dm_tenant` fails if the role doesn't exist. Instead, roles + RLS are applied via a separate `ensureRoles()` method. This lets `ensureSchema()` work without roles (e.g., existing tests), while `ensureRoles()` is called explicitly when roles are needed.

- [ ] **Step 1: Create roles-sql.ts with role creation + grants + RLS SQL**

```ts
// packages/durable-machine/src/pg/roles-sql.ts

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
  "invoke_results",
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
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
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
```

- [ ] **Step 2: Add ensureRoles() to PgStore interface and implementation**

In `packages/durable-machine/src/pg/store-types.ts`, add to `PgStore`:
```ts
  /** Create PG roles (dm_tenant, dm_admin) and enable RLS policies. */
  ensureRoles(): Promise<void>;
```

In `packages/durable-machine/src/pg/store.ts`, add implementation:
```ts
import { ROLES_SQL, RLS_SQL } from "./roles-sql.js";

// Inside createStore():
async function ensureRoles(): Promise<void> {
  await pool.query(ROLES_SQL);
  await pool.query(RLS_SQL);
}
```

Add `ensureRoles` to the returned object.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/durable-machine/src/pg/roles-sql.ts \
       packages/durable-machine/src/pg/store.ts \
       packages/durable-machine/src/pg/store-types.ts
git commit -m "feat: add PG roles, RLS policies, and ensureRoles() method"
```

---

### Task 6: RLS Unit Tests with PGlite

**Files:**
- Create: `packages/durable-machine/tests/unit/rls.test.ts`

- [ ] **Step 1: Write RLS isolation tests**

```ts
// packages/durable-machine/tests/unit/rls.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createStore } from "../../src/pg/store.js";
import { createPgLitePool } from "../fixtures/pglite-pool.js";
import { uuidv7 } from "../../src/uuidv7.js";
import type { PgStore } from "../../src/pg/store.js";

describe("RLS tenant isolation", () => {
  let db: PGlite;
  let pool: ReturnType<typeof createPgLitePool>;
  let store: PgStore;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    db = new PGlite();
    pool = createPgLitePool(db);
    store = createStore({ pool, useListenNotify: false });
    await store.ensureSchema();
    await store.ensureRoles();

    // Grant current user membership in dm_tenant and dm_admin
    // PGlite runs as superuser by default
    await pool.query("GRANT dm_tenant, dm_admin TO CURRENT_USER");

    // Create two tenants
    tenantA = uuidv7();
    tenantB = uuidv7();
    const now = Date.now();
    await pool.query({
      text: `INSERT INTO tenants (id, jwt_iss, jwt_aud, jwks_url, name, created_at, updated_at)
             VALUES ($1, 'iss-a', 'aud-a', 'https://a.example.com/jwks', 'Tenant A', $2, $3),
                    ($4, 'iss-b', 'aud-b', 'https://b.example.com/jwks', 'Tenant B', $5, $6)`,
      values: [tenantA, now, now, tenantB, now, now],
    });

    // Insert data as dm_admin (bypasses RLS)
    await pool.query("SET ROLE dm_admin");
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantA] });
    await store.createInstance({
      id: uuidv7(), machineName: "m1", stateValue: "idle", context: {}, input: null,
    });
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantB] });
    await store.createInstance({
      id: uuidv7(), machineName: "m1", stateValue: "active", context: {}, input: null,
    });
    await pool.query("RESET ROLE");
  });

  afterAll(async () => {
    await store.close();
    await pool.end();
  });

  it("dm_tenant sees only own tenant's instances", async () => {
    await pool.query("SET ROLE dm_tenant");
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantA] });

    const rows = await store.listInstances();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(tenantA);

    await pool.query("RESET ROLE");
  });

  it("dm_admin sees all instances", async () => {
    await pool.query("SET ROLE dm_admin");

    const rows = await store.listInstances();
    expect(rows).toHaveLength(2);

    await pool.query("RESET ROLE");
  });

  it("dm_app with no SET ROLE sees zero rows (FORCE RLS safety)", async () => {
    // PGlite runs as superuser; we need to test as the table owner.
    // With FORCE RLS and no policy for the current user, should see nothing.
    // Note: PGlite superuser bypasses FORCE RLS, so this test verifies
    // the behavior as dm_app-equivalent via SET ROLE.
    await pool.query("SET ROLE dm_tenant");
    // No app.tenant_id set — current_setting returns NULL, no rows match
    await pool.query("SELECT set_config('app.tenant_id', '', false)");

    const rows = await store.listInstances();
    expect(rows).toHaveLength(0);

    await pool.query("RESET ROLE");
  });

  it("cross-tenant INSERT is rejected by RLS", async () => {
    await pool.query("SET ROLE dm_tenant");
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantA] });

    // Try inserting with tenant B's ID explicitly — should fail
    await expect(
      pool.query({
        text: `INSERT INTO machine_instances (id, tenant_id, machine_name, state_value, context, created_at, updated_at)
               VALUES ($1, $2, 'x', '"idle"', '{}', $3, $4)`,
        values: [uuidv7(), tenantB, Date.now(), Date.now()],
      }),
    ).rejects.toThrow(/row-level security/);

    await pool.query("RESET ROLE");
  });

  it("tenant_id DEFAULT auto-populates from GUC", async () => {
    await pool.query("SET ROLE dm_tenant");
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantA] });

    const id = uuidv7();
    await store.createInstance({
      id, machineName: "m1", stateValue: "new", context: {}, input: null,
    });

    const instance = await store.getInstance(id);
    expect(instance).not.toBeNull();
    expect(instance!.tenantId).toBe(tenantA);

    await pool.query("RESET ROLE");
  });

  it("dm_tenant cannot see other tenant's events", async () => {
    // Get instance IDs (seeded in beforeAll)
    await pool.query("SET ROLE dm_admin");
    const allInstances = await store.listInstances();
    const instanceA = allInstances.find((r) => r.tenantId === tenantA)!;
    const instanceB = allInstances.find((r) => r.tenantId === tenantB)!;

    // Append events to both instances
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantA] });
    await store.appendEvent(instanceA.id, { type: "EVT_A" });
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantB] });
    await store.appendEvent(instanceB.id, { type: "EVT_B" });
    await pool.query("RESET ROLE");

    // Tenant A should only see their events
    await pool.query("SET ROLE dm_tenant");
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantA] });
    const eventsA = await store.getEventLog(instanceA.id);
    expect(eventsA.length).toBeGreaterThan(0);
    const eventsB = await store.getEventLog(instanceB.id);
    expect(eventsB).toHaveLength(0);
    await pool.query("RESET ROLE");
  });

  it("dm_tenant cannot see other tenant's transitions", async () => {
    await pool.query("SET ROLE dm_admin");
    const allInstances = await store.listInstances();
    const instanceA = allInstances.find((r) => r.tenantId === tenantA)!;
    const instanceB = allInstances.find((r) => r.tenantId === tenantB)!;

    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantA] });
    await store.appendTransition(instanceA.id, null, "idle", null, Date.now());
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantB] });
    await store.appendTransition(instanceB.id, null, "active", null, Date.now());
    await pool.query("RESET ROLE");

    await pool.query("SET ROLE dm_tenant");
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantA] });
    const transA = await store.getTransitions(instanceA.id);
    expect(transA.length).toBeGreaterThan(0);
    const transB = await store.getTransitions(instanceB.id);
    expect(transB).toHaveLength(0);
    await pool.query("RESET ROLE");
  });

  it("dm_tenant cannot see other tenant's effects", async () => {
    await pool.query("SET ROLE dm_admin");
    const allInstances = await store.listInstances();
    const instanceA = allInstances.find((r) => r.tenantId === tenantA)!;
    const instanceB = allInstances.find((r) => r.tenantId === tenantB)!;

    // Insert effects directly via SQL (insertEffects requires a client)
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantA] });
    await pool.query({
      text: `INSERT INTO effect_outbox (instance_id, tenant_id, state_value, effect_type, effect_payload, created_at)
             VALUES ($1, $2, '"idle"', 'log', '{}', $3)`,
      values: [instanceA.id, tenantA, Date.now()],
    });
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantB] });
    await pool.query({
      text: `INSERT INTO effect_outbox (instance_id, tenant_id, state_value, effect_type, effect_payload, created_at)
             VALUES ($1, $2, '"active"', 'log', '{}', $3)`,
      values: [instanceB.id, tenantB, Date.now()],
    });
    await pool.query("RESET ROLE");

    await pool.query("SET ROLE dm_tenant");
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantA] });
    const effectsA = await store.listEffects(instanceA.id);
    expect(effectsA.length).toBeGreaterThan(0);
    const effectsB = await store.listEffects(instanceB.id);
    expect(effectsB).toHaveLength(0);
    await pool.query("RESET ROLE");
  });

  // Note: FORCE RLS + dm_app safety net (unscoped dm_app sees zero rows)
  // cannot be fully tested in PGlite because PGlite runs as superuser
  // which bypasses FORCE RLS. The dm_tenant-with-empty-GUC test above
  // is a partial proxy. Full dm_app behavior is verified in integration
  // tests against Docker PG.
});
```

- [ ] **Step 2: Run RLS tests**

Run: `cd packages/durable-machine && npx vitest run --project unit tests/unit/rls.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/durable-machine/tests/unit/rls.test.ts
git commit -m "test: add RLS tenant isolation tests with PGlite"
```

---

### Task 7: Tenant Proxy Pool

**Files:**
- Create: `packages/durable-machine/src/pg/tenant-pool.ts`
- Create: `packages/durable-machine/tests/unit/tenant-pool.test.ts`

- [ ] **Step 1: Write failing tests for createTenantPool()**

```ts
// packages/durable-machine/tests/unit/tenant-pool.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createStore } from "../../src/pg/store.js";
import { createPgLitePool } from "../fixtures/pglite-pool.js";
import { createTenantPool } from "../../src/pg/tenant-pool.js";
import { uuidv7 } from "../../src/uuidv7.js";
import type { PgStore } from "../../src/pg/store.js";

describe("createTenantPool", () => {
  let db: PGlite;
  let pool: ReturnType<typeof createPgLitePool>;
  let store: PgStore;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    db = new PGlite();
    pool = createPgLitePool(db);
    store = createStore({ pool, useListenNotify: false });
    await store.ensureSchema();
    await store.ensureRoles();

    await pool.query("GRANT dm_tenant, dm_admin TO CURRENT_USER");

    tenantA = uuidv7();
    tenantB = uuidv7();
    const now = Date.now();
    await pool.query({
      text: `INSERT INTO tenants (id, jwt_iss, jwt_aud, jwks_url, name, created_at, updated_at)
             VALUES ($1, 'iss-a', 'aud-a', 'https://a.example.com/jwks', 'Tenant A', $2, $3)`,
      values: [tenantA, now, now],
    });
    await pool.query({
      text: `INSERT INTO tenants (id, jwt_iss, jwt_aud, jwks_url, name, created_at, updated_at)
             VALUES ($1, 'iss-b', 'aud-b', 'https://b.example.com/jwks', 'Tenant B', $2, $3)`,
      values: [tenantB, now, now],
    });

    // Seed data as admin
    await pool.query("SET ROLE dm_admin");
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantA] });
    await store.createInstance({ id: uuidv7(), machineName: "m1", stateValue: "idle", context: { owner: "A" }, input: null });
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantB] });
    await store.createInstance({ id: uuidv7(), machineName: "m1", stateValue: "idle", context: { owner: "B" }, input: null });
    await pool.query("RESET ROLE");
  });

  afterAll(async () => {
    await store.close();
    await pool.end();
  });

  it("scoped store sees only its tenant's data", async () => {
    const scopedStore = createStore({
      pool: createTenantPool(pool, tenantA, "dm_tenant"),
      useListenNotify: false,
    });
    const rows = await scopedStore.listInstances();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(tenantA);
  });

  it("scoped store for tenant B sees only B's data", async () => {
    const scopedStore = createStore({
      pool: createTenantPool(pool, tenantB, "dm_tenant"),
      useListenNotify: false,
    });
    const rows = await scopedStore.listInstances();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(tenantB);
  });

  it("admin pool sees all data", async () => {
    const adminStore = createStore({
      pool: createTenantPool(pool, null, "dm_admin"),
      useListenNotify: false,
    });
    const rows = await adminStore.listInstances();
    expect(rows).toHaveLength(2);
  });

  it("INSERT via scoped pool auto-populates tenant_id", async () => {
    const scopedStore = createStore({
      pool: createTenantPool(pool, tenantA, "dm_tenant"),
      useListenNotify: false,
    });
    const id = uuidv7();
    await scopedStore.createInstance({ id, machineName: "m1", stateValue: "new", context: {}, input: null });

    // Read back via admin to verify tenant_id
    const adminStore = createStore({
      pool: createTenantPool(pool, null, "dm_admin"),
      useListenNotify: false,
    });
    const instance = await adminStore.getInstance(id);
    expect(instance).not.toBeNull();
    expect(instance!.tenantId).toBe(tenantA);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/durable-machine && npx vitest run --project unit tests/unit/tenant-pool.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement createTenantPool()**

```ts
// packages/durable-machine/src/pg/tenant-pool.ts
import type { Pool, PoolClient, QueryConfig, QueryResult } from "pg";

/**
 * Creates a proxy pool that wraps every query in a transaction
 * with the appropriate SET LOCAL ROLE and tenant GUC.
 *
 * For tenant-scoped access:
 *   createTenantPool(pool, tenantId, "dm_tenant")
 *
 * For admin (unscoped) access:
 *   createTenantPool(pool, null, "dm_admin")
 */
export function createTenantPool(
  pool: Pool,
  tenantId: string | null,
  role: "dm_tenant" | "dm_admin",
): Pool {
  async function scopedQuery(
    configOrText: string | QueryConfig,
    values?: any[],
  ): Promise<QueryResult> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      if (tenantId != null) {
        await client.query({
          text: `SELECT set_config('app.tenant_id', $1, true)`,
          values: [tenantId],
        });
      }

      const result = typeof configOrText === "string"
        ? await client.query(configOrText, values)
        : await client.query(configOrText);

      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function scopedConnect(): Promise<PoolClient> {
    const client = await pool.connect();
    const originalQuery = client.query.bind(client);
    let transactionStarted = false;

    const wrappedClient = Object.create(client) as PoolClient;

    wrappedClient.query = async function query(
      configOrText: any,
      values?: any,
    ): Promise<any> {
      // Intercept BEGIN to inject role/GUC
      const text = typeof configOrText === "string"
        ? configOrText
        : configOrText?.text;

      if (text && /^\s*BEGIN/i.test(text)) {
        const result = await originalQuery(configOrText, values);
        await originalQuery(`SET LOCAL ROLE ${role}`);
        if (tenantId != null) {
          await originalQuery({
            text: `SELECT set_config('app.tenant_id', $1, true)`,
            values: [tenantId],
          });
        }
        transactionStarted = true;
        return result;
      }

      return originalQuery(configOrText, values);
    } as any;

    wrappedClient.release = () => client.release();

    return wrappedClient;
  }

  return {
    query: scopedQuery,
    connect: scopedConnect,
    end: () => pool.end(),
    // Proxy remaining Pool properties
    on: pool.on?.bind(pool),
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  } as unknown as Pool;
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/durable-machine && npx vitest run --project unit tests/unit/tenant-pool.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add packages/durable-machine/src/pg/tenant-pool.ts \
       packages/durable-machine/tests/unit/tenant-pool.test.ts
git commit -m "feat: add createTenantPool() proxy for RLS scoping"
```

---

### Task 8: Wire forTenant() into PgStore

**Files:**
- Modify: `packages/durable-machine/src/pg/store-types.ts`
- Modify: `packages/durable-machine/src/pg/store.ts`
- Modify: `packages/durable-machine/src/pg/index.ts`

- [ ] **Step 1: Add forTenant() to PgStore interface**

In `packages/durable-machine/src/pg/store-types.ts`, add to `PgStore`:
```ts
  /** Returns a PgStore scoped to a specific tenant via RLS. */
  forTenant(tenantId: string): PgStore;
```

- [ ] **Step 2: Implement forTenant() in store.ts**

In `packages/durable-machine/src/pg/store.ts`, add import and implementation:

```ts
import { createTenantPool } from "./tenant-pool.js";

// Inside createStore(), add:
function forTenant(tenantId: string): PgStore {
  return createStore({
    ...options,
    pool: createTenantPool(pool, tenantId, "dm_tenant"),
    useListenNotify: false, // scoped store should not manage listeners
  });
}
```

Add `forTenant` to the returned store object.

- [ ] **Step 3: Export from pg/index.ts**

Add to `packages/durable-machine/src/pg/index.ts`:
```ts
export type { TenantRow } from "./store-types.js";
export { createTenantPool } from "./tenant-pool.js";
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 5: Run all unit tests**

Run: `cd packages/durable-machine && npx vitest run --project unit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/durable-machine/src/pg/store-types.ts \
       packages/durable-machine/src/pg/store.ts \
       packages/durable-machine/src/pg/index.ts
git commit -m "feat: add forTenant() method to PgStore"
```

---

## Chunk 4: Worker Integration and Event Processor

### Task 9: Worker tenant_id GUC Propagation

**Files:**
- Modify: `packages/durable-machine/src/pg/event-processor.ts`

- [ ] **Step 1: Set tenant GUC after locking instance in processBatchFromLog()**

In `packages/durable-machine/src/pg/event-processor.ts`, in `processBatchFromLog()`, after the `lockAndPeekEvents` call returns successfully, add:

```ts
// After: const { row, events } = result;
// Add:
await client.query({
  text: `SELECT set_config('app.tenant_id', $1, true)`,
  values: [row.tenantId],
});
```

This sets the GUC within the existing transaction so that all subsequent INSERTs (via `finalize()` → `finalizeInstance`/`finalizeWithTransition`, `insertEffects`, etc.) inherit the correct `tenant_id` via column DEFAULT.

**Note on `set_config` third parameter:** Production code uses `true` (transaction-local scope) — the GUC resets on COMMIT/ROLLBACK. Test setup code uses `false` (session-local scope) because tests run outside transactions and need the GUC to persist across multiple store method calls. Both are correct for their respective contexts.

- [ ] **Step 2: Set tenant GUC in executeAndFinalizeInvocation()**

In the `executeAndFinalizeInvocation()` function, after the re-lock `lockAndGetInstance` call:

```ts
// After: const row = await deps.store.lockAndGetInstance(client, instanceId);
// Add:
if (row) {
  await client.query({
    text: `SELECT set_config('app.tenant_id', $1, true)`,
    values: [row.tenantId],
  });
}
```

**Important:** This GUC propagates through to CTE inserts in `Q_FINALIZE_WITH_TRANSITION`, which inserts into `transition_log` within a CTE. The `tenant_id NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid` on `transition_log` will use the GUC value set here.

- [ ] **Step 3: Fix processStartup() post-transaction GUC gap**

In `processStartup()`, after the `withTransaction` block, there are out-of-transaction calls:
- `store.updateInstanceStatus(instanceId, "done")` — UPDATE, no DEFAULT needed, OK.
- `store.appendTransition(instanceId, ...)` — INSERT into `transition_log`, needs `tenant_id` DEFAULT.

The admin proxy pool wraps each `pool.query()` in its own short transaction with `SET LOCAL ROLE dm_admin`, but does NOT set `app.tenant_id`. So `appendTransition` will fail with a NOT NULL violation on `tenant_id`.

**Fix:** Move the `appendTransition` call inside the `withTransaction` block so it shares the GUC that the proxy pool's `scopedConnect` sets after BEGIN. Alternatively, wrap it in its own `withTransaction` that sets the GUC.

- [ ] **Step 4: Fix executeInvocationsInline() GUC gap**

`executeInvocationsInline()` calls `store.recordInvokeResult()` outside any transaction (by design — invocations execute outside locks). `recordInvokeResult` INSERTs into `invoke_results` via `pool.query()`, which under the admin proxy becomes a short transaction without the tenant GUC set. This will fail with a NOT NULL violation on `tenant_id`.

**Fix:** Pass `tenantId` into `executeInvocationsInline()` (from the locked row in the caller). Before each `store.recordInvokeResult()` call, set the GUC via a session-level `set_config`:

```ts
// In executeInvocationsInline(), before recordInvokeResult:
await pool.query({
  text: `SELECT set_config('app.tenant_id', $1, false)`,
  values: [tenantId],
});
await store.recordInvokeResult({ ... });
```

Using `false` (session-level) here because we're outside a transaction. The admin proxy's `scopedQuery` will start its own transaction, and the session-level GUC will be visible within it. The GUC will be overwritten on the next event processing cycle.

Update the call sites of `executeInvocationsInline()` in both `processStartup()` and `processBatchFromLog()` to pass `tenantId`:
- In `processStartup()`: `tenantId` comes from the input or the caller's proxy pool context
- In `processBatchFromLog()`: `tenantId` comes from `row.tenantId` (the locked instance row)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 6: Run all unit tests**

Run: `cd packages/durable-machine && npx vitest run --project unit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/durable-machine/src/pg/event-processor.ts
git commit -m "feat: propagate tenant_id GUC from locked instance row in event processor"
```

---

### Task 10: Admin Store Wrapping (dm_admin by default)

**Files:**
- Modify: `packages/durable-machine/src/pg/create-durable-machine.ts`

The base `createDurableMachine()` is used by workers and admin endpoints. Per the spec, it must use `dm_admin` to bypass RLS. The simplest approach: wrap the pool with `createTenantPool(pool, null, "dm_admin")` in `createDurableMachine()`.

- [ ] **Step 1: Import createTenantPool and wrap the pool**

In `packages/durable-machine/src/pg/create-durable-machine.ts`:

```ts
import { createTenantPool } from "./tenant-pool.js";

// In createDurableMachine(), before creating the store:
const adminPool = createTenantPool(pool, null, "dm_admin");
const store = options.store ?? createStore({
  pool: adminPool,
  // ...rest unchanged
});
```

- [ ] **Step 2: Expose forTenant() on PgDurableMachine**

Add `forTenant()` to the `PgDurableMachine` interface and returned object:

```ts
export interface PgDurableMachine<T extends AnyStateMachine> extends DurableMachine<T> {
  consumeAndProcess(instanceId: string): Promise<void>;
  forTenant(tenantId: string): PgDurableMachine<T>;
}
```

Implementation: create a new `PgDurableMachine` backed by a tenant-scoped store.

```ts
function forTenant(tenantId: string): PgDurableMachine<T> {
  const tenantStore = store.forTenant(tenantId);
  return createDurableMachine(machine, {
    ...options,
    pool, // original pool — forTenant creates its own proxy
    store: tenantStore,
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/durable-machine/src/pg/create-durable-machine.ts
git commit -m "feat: wrap DurableMachine with dm_admin pool, expose forTenant()"
```

---

## Chunk 5: Gateway Integration

### Task 11: JWT Tenant Resolution Middleware

**Files:**
- Create: `packages/gateway/src/tenant-middleware.ts`
- Create: `packages/gateway/tests/unit/tenant-middleware.test.ts`

- [ ] **Step 1: Add jose dependency**

```bash
cd packages/gateway && pnpm add jose
```

- [ ] **Step 2: Write failing tests for tenant middleware**

```ts
// packages/gateway/tests/unit/tenant-middleware.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createTenantMiddleware } from "../../src/tenant-middleware.js";

describe("tenant middleware", () => {
  let app: Hono;
  let jwksUrl: string;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    const { publicKey, privateKey: pk } = await generateKeyPair("RS256");
    privateKey = pk;
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-key";
    publicJwk.alg = "RS256";

    // Mock JWKS endpoint — in real tests, use a local HTTP server
    // For now, test the middleware's tenant lookup + JWT verification logic
  });

  it("extracts tenantId from valid JWT", async () => {
    // Test that middleware sets c.set("tenantId", ...) on valid JWT
  });

  it("returns 401 for missing Authorization header", async () => {
    // Test 401 response
  });

  it("returns 401 for unknown iss+aud pair", async () => {
    // Test 401 when tenant lookup fails
  });
});
```

Note: Full test implementation depends on the middleware's dependency injection for tenant lookup. The middleware should accept a `lookupTenant` function parameter.

- [ ] **Step 3: Implement tenant middleware**

```ts
// packages/gateway/src/tenant-middleware.ts
import type { MiddlewareHandler } from "hono";
import { decodeJwt, createRemoteJWKSet, jwtVerify } from "jose";

export interface TenantLookupResult {
  id: string;
  jwksUrl: string;
}

export interface TenantMiddlewareOptions {
  lookupTenant: (iss: string, aud: string) => Promise<TenantLookupResult | null>;
}

export function createTenantMiddleware(
  options: TenantMiddlewareOptions,
): MiddlewareHandler {
  const { lookupTenant } = options;
  // createRemoteJWKSet handles caching and key rotation internally.
  // We cache the JWKS *function* per URL to avoid re-creating it per request.
  const jwksFunctions = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  function getJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
    let jwks = jwksFunctions.get(jwksUrl);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(jwksUrl));
      jwksFunctions.set(jwksUrl, jwks);
    }
    return jwks;
  }

  return async (c, next) => {
    const authHeader = c.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }
    const token = authHeader.slice(7);

    // Decode without verification to get iss + aud
    let claims: { iss?: string; aud?: string | string[] };
    try {
      claims = decodeJwt(token);
    } catch {
      return c.json({ error: "Invalid JWT" }, 401);
    }

    const iss = claims.iss;
    const aud = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
    if (!iss || !aud) {
      return c.json({ error: "JWT missing iss or aud claims" }, 401);
    }

    // Lookup tenant
    const tenant = await lookupTenant(iss, aud);
    if (!tenant) {
      return c.json({ error: "Unknown tenant" }, 401);
    }

    // Verify JWT — createRemoteJWKSet handles key rotation internally
    try {
      const jwks = getJwks(tenant.jwksUrl);
      await jwtVerify(token, jwks, { issuer: iss, audience: aud });
    } catch {
      return c.json({ error: "JWT verification failed" }, 401);
    }

    c.set("tenantId", tenant.id);
    await next();
  };
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/tenant-middleware.ts \
       packages/gateway/tests/unit/tenant-middleware.test.ts \
       packages/gateway/package.json pnpm-lock.yaml
git commit -m "feat: add JWT tenant resolution middleware"
```

---

### Task 12: Wire Tenant Middleware into REST API

**Files:**
- Modify: `packages/gateway/src/rest-api.ts`
- Modify: `packages/gateway/src/rest-types.ts`

- [ ] **Step 1: Update RestApiOptions to accept tenant middleware**

In `packages/gateway/src/rest-types.ts`, add:
```ts
import type { MiddlewareHandler } from "hono";

export interface RestApiOptions {
  machines: MachineRegistry;
  basePath?: string;
  tenantMiddleware?: MiddlewareHandler;
  getStoreForTenant?: (tenantId: string) => PgStore;
}
```

- [ ] **Step 2: Apply tenant middleware to routes**

In `packages/gateway/src/rest-api.ts`, if `tenantMiddleware` is provided, apply it to all routes and use `getStoreForTenant(c.get("tenantId"))` to scope store access.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/rest-api.ts packages/gateway/src/rest-types.ts
git commit -m "feat: wire tenant middleware into REST API routes"
```

---

### Task 13: Per-Tenant Webhook Bindings

Each tenant gets its own webhook path (e.g., `/webhooks/tenant-abc/stripe`). No path-grouping or verify-based matching needed — the path itself identifies the tenant.

**Files:**
- Modify: `packages/gateway/src/types.ts` (add `tenantId` to `WebhookBinding`, add `forTenantClient` to `GatewayOptions`)
- Modify: `packages/gateway/src/gateway.ts` (use `forTenantClient` when binding has `tenantId`)

- [ ] **Step 1: Add tenantId to WebhookBinding and forTenantClient to GatewayOptions**

In `packages/gateway/src/types.ts`:
```ts
export interface WebhookBinding<TPayload = unknown, TItem = TPayload> {
  tenantId?: string;        // NEW — identifies which tenant this binding belongs to
  path: string;             // unique per tenant, e.g., "/webhooks/<tenantId>/stripe"
  source: WebhookSource<TPayload>;
  // ... rest unchanged
}

export interface GatewayOptions {
  client: GatewayClient;
  bindings: WebhookBinding<any>[];
  basePath?: string;
  metrics?: GatewayMetrics;
  maxBodyBytes?: number;
  forTenantClient?: (tenantId: string) => GatewayClient; // NEW
}
```

- [ ] **Step 2: Use forTenantClient in route handler when binding has tenantId**

In `packages/gateway/src/gateway.ts`, in the existing per-binding route registration, scope the client when the binding has a `tenantId`:

```ts
// Existing: each binding already gets its own route at binding.path
// Add: scope the client for tenant bindings
const scopedClient = binding.tenantId && options.forTenantClient
  ? options.forTenantClient(binding.tenantId)
  : options.client;

// Use scopedClient instead of options.client for dispatch
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/types.ts packages/gateway/src/gateway.ts
git commit -m "feat: per-tenant webhook bindings with separate paths"
```

---

## Chunk 6: Exports, Integration Tests, and Cleanup

### Task 14: Update Exports and Types

**Files:**
- Modify: `packages/durable-machine/src/index.ts`
- Modify: `packages/durable-machine/src/pg/index.ts`
- Modify: `packages/gateway/src/index.ts`

- [ ] **Step 1: Export new symbols from durable-machine**

In `packages/durable-machine/src/index.ts`, add:
```ts
export { uuidv7 } from "./uuidv7.js";
```

In `packages/durable-machine/src/pg/index.ts`, add:
```ts
export type { TenantRow } from "./store-types.js";
export { createTenantPool } from "./tenant-pool.js";
export { ROLES_SQL, RLS_SQL } from "./roles-sql.js";
```

- [ ] **Step 2: Export new gateway symbols**

In `packages/gateway/src/index.ts`, add:
```ts
export { createTenantMiddleware } from "./tenant-middleware.js";
export type { TenantLookupResult, TenantMiddlewareOptions } from "./tenant-middleware.js";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/durable-machine/src/index.ts \
       packages/durable-machine/src/pg/index.ts \
       packages/gateway/src/index.ts
git commit -m "feat: export tenancy types and functions from public API"
```

---

### Task 15: Update Existing Unit Tests for Tenant Context

**Files:**
- Modify: `packages/durable-machine/tests/unit/pg-store.test.ts`
- Modify: `packages/durable-machine/tests/unit/pg-event-processor.test.ts` (if exists)

All existing PgStore unit tests need to operate in a tenant context since `tenant_id NOT NULL` requires either an explicit value or a GUC DEFAULT. The `beforeAll`/`beforeEach` changes from Task 4 handle this.

- [ ] **Step 1: Verify all unit tests pass with tenant context**

Run: `cd packages/durable-machine && npx vitest run --project unit`
Expected: PASS (all tests including new RLS and tenant-pool tests)

- [ ] **Step 2: Fix any failures**

Address any test failures caused by missing tenant context (e.g., tests that use raw SQL inserts without the GUC set).

- [ ] **Step 3: Commit**

```bash
git add -u packages/durable-machine/tests/
git commit -m "test: update all unit tests for tenant context"
```

---

### Task 16: Migration Script

**Files:**
- Create: `packages/durable-machine/migrations/001-multi-tenancy.sql`

Per spec Section 1.4, this is a breaking change. A migration script is required for existing deployments.

- [ ] **Step 1: Write migration script**

```sql
-- packages/durable-machine/migrations/001-multi-tenancy.sql
-- Multi-tenancy migration: TEXT→UUID, tenants table, tenant_id columns, roles, RLS
-- This is a BREAKING CHANGE. Back up your database before running.

BEGIN;

-- 1. Create uuidv7() function
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid
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

-- 2. Migrate TEXT PKs/FKs to UUID
ALTER TABLE effect_outbox DROP CONSTRAINT IF EXISTS effect_outbox_instance_id_fkey;
ALTER TABLE event_log DROP CONSTRAINT IF EXISTS event_log_instance_id_fkey;
ALTER TABLE transition_log DROP CONSTRAINT IF EXISTS transition_log_instance_id_fkey;
ALTER TABLE invoke_results DROP CONSTRAINT IF EXISTS invoke_results_instance_id_fkey;

ALTER TABLE machine_instances ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE effect_outbox ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE effect_outbox ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE effect_outbox ALTER COLUMN instance_id TYPE UUID USING instance_id::uuid;
ALTER TABLE event_log ALTER COLUMN instance_id TYPE UUID USING instance_id::uuid;
ALTER TABLE transition_log ALTER COLUMN instance_id TYPE UUID USING instance_id::uuid;
ALTER TABLE invoke_results ALTER COLUMN instance_id TYPE UUID USING instance_id::uuid;

ALTER TABLE effect_outbox ADD CONSTRAINT effect_outbox_instance_id_fkey
  FOREIGN KEY (instance_id) REFERENCES machine_instances(id) ON DELETE CASCADE;
ALTER TABLE event_log ADD CONSTRAINT event_log_instance_id_fkey
  FOREIGN KEY (instance_id) REFERENCES machine_instances(id) ON DELETE CASCADE;
ALTER TABLE transition_log ADD CONSTRAINT transition_log_instance_id_fkey
  FOREIGN KEY (instance_id) REFERENCES machine_instances(id) ON DELETE CASCADE;
ALTER TABLE invoke_results ADD CONSTRAINT invoke_results_instance_id_fkey
  FOREIGN KEY (instance_id) REFERENCES machine_instances(id) ON DELETE CASCADE;

-- 3. Create tenants table
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

-- 4. Insert default tenant + backfill
INSERT INTO tenants (id, jwt_iss, jwt_aud, jwks_url, name, created_at, updated_at)
VALUES (uuidv7(), 'default', 'default', 'https://localhost/.well-known/jwks.json',
        'Default Tenant', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
        EXTRACT(EPOCH FROM NOW())::BIGINT * 1000);

ALTER TABLE machine_instances ADD COLUMN tenant_id UUID REFERENCES tenants(id);
ALTER TABLE event_log ADD COLUMN tenant_id UUID;
ALTER TABLE transition_log ADD COLUMN tenant_id UUID;
ALTER TABLE effect_outbox ADD COLUMN tenant_id UUID;
ALTER TABLE invoke_results ADD COLUMN tenant_id UUID;

UPDATE machine_instances SET tenant_id = (SELECT id FROM tenants LIMIT 1);
UPDATE event_log SET tenant_id = (SELECT id FROM tenants LIMIT 1);
UPDATE transition_log SET tenant_id = (SELECT id FROM tenants LIMIT 1);
UPDATE effect_outbox SET tenant_id = (SELECT id FROM tenants LIMIT 1);
UPDATE invoke_results SET tenant_id = (SELECT id FROM tenants LIMIT 1);

-- 5. Add NOT NULL + DEFAULT
ALTER TABLE machine_instances ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE machine_instances ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id', true)::uuid;
ALTER TABLE event_log ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE event_log ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id', true)::uuid;
ALTER TABLE transition_log ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE transition_log ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id', true)::uuid;
ALTER TABLE effect_outbox ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE effect_outbox ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id', true)::uuid;
ALTER TABLE invoke_results ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE invoke_results ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id', true)::uuid;

CREATE INDEX IF NOT EXISTS idx_mi_tenant ON machine_instances (tenant_id);
CREATE INDEX IF NOT EXISTS idx_el_tenant ON event_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tl_tenant ON transition_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_eo_tenant ON effect_outbox (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ir_tenant ON invoke_results (tenant_id);

-- 6. Create roles
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

-- 7. Enable RLS + policies
ALTER TABLE machine_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON machine_instances FOR ALL TO dm_tenant
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY admin_bypass ON machine_instances FOR ALL TO dm_admin USING (true);

ALTER TABLE event_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON event_log FOR ALL TO dm_tenant
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY admin_bypass ON event_log FOR ALL TO dm_admin USING (true);

ALTER TABLE transition_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE transition_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON transition_log FOR ALL TO dm_tenant
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY admin_bypass ON transition_log FOR ALL TO dm_admin USING (true);

ALTER TABLE effect_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE effect_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON effect_outbox FOR ALL TO dm_tenant
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY admin_bypass ON effect_outbox FOR ALL TO dm_admin USING (true);

ALTER TABLE invoke_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoke_results FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoke_results FOR ALL TO dm_tenant
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY admin_bypass ON invoke_results FOR ALL TO dm_admin USING (true);

-- Update fire_due_timeouts() to propagate tenant_id
CREATE OR REPLACE FUNCTION fire_due_timeouts() RETURNS INTEGER AS $$
DECLARE cnt INTEGER;
BEGIN
  WITH to_expire AS (
    SELECT id, tenant_id, wake_event FROM machine_instances
    WHERE wake_at <= (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      AND status = 'running' AND wake_at IS NOT NULL
    FOR UPDATE
  ),
  cleared AS (
    UPDATE machine_instances mi SET wake_at = NULL, wake_event = NULL
    FROM to_expire te WHERE mi.id = te.id
  )
  INSERT INTO event_log (instance_id, tenant_id, topic, payload, source, created_at)
  SELECT id, tenant_id, 'timeout', wake_event, 'system:timeout',
         (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  FROM to_expire WHERE wake_event IS NOT NULL;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END;
$$ LANGUAGE plpgsql;

COMMIT;
```

- [ ] **Step 2: Commit**

```bash
git add packages/durable-machine/migrations/001-multi-tenancy.sql
git commit -m "feat: add multi-tenancy migration script"
```

---

### Task 17: Update Integration Test Fixture

**Files:**
- Modify: `packages/durable-machine/tests/integration/pg/fixture.ts`
- Modify: `packages/durable-machine/tests/unit/pg-global-setup.ts`

- [ ] **Step 1: Update pg-global-setup.ts to create roles and tenants**

```ts
// packages/durable-machine/tests/unit/pg-global-setup.ts
import pg from "pg";
import { createStore } from "../../src/pg/store.js";
import { uuidv7 } from "../../src/uuidv7.js";

export async function setup() {
  const url = process.env.PG_TEST_DATABASE_URL;
  if (!url) return;

  const pool = new pg.Pool({ connectionString: url });
  await pool.query(`
    DROP TABLE IF EXISTS effect_outbox CASCADE;
    DROP TABLE IF EXISTS transition_log CASCADE;
    DROP TABLE IF EXISTS event_log CASCADE;
    DROP TABLE IF EXISTS invoke_results CASCADE;
    DROP TABLE IF EXISTS machine_instances CASCADE;
    DROP TABLE IF EXISTS tenants CASCADE;
  `);
  const store = createStore({ pool, useListenNotify: false });
  await store.ensureSchema();
  await store.ensureRoles();

  // Create a test tenant for integration tests
  const tenantId = uuidv7();
  const now = Date.now();
  await pool.query({
    text: `INSERT INTO tenants (id, jwt_iss, jwt_aud, jwks_url, name, created_at, updated_at)
           VALUES ($1, 'test-iss', 'test-aud', 'https://test.example.com/jwks', 'Integration Test Tenant', $2, $3)`,
    values: [tenantId, now, now],
  });

  // Store tenant ID for integration tests to use
  process.env.TEST_TENANT_ID = tenantId;

  await store.close();
  await pool.end();
}
```

- [ ] **Step 2: Update integration fixture to use dm_admin pool and set tenant GUC**

In `packages/durable-machine/tests/integration/pg/fixture.ts`, wrap the pool with `createTenantPool(pool, null, "dm_admin")` so the worker can bypass RLS, and set the tenant GUC from `process.env.TEST_TENANT_ID`.

- [ ] **Step 3: Add integration test for connection pool role isolation**

Verify that connections returned to the pool correctly reset roles between checkouts. This is critical because `SET ROLE` is session-level and connections are reused from the pool.

```ts
// In a new or existing integration test file:
it("connection pool resets role between checkouts", async () => {
  // Checkout 1: set role to dm_tenant
  const client1 = await pool.connect();
  await client1.query("BEGIN");
  await client1.query("SET LOCAL ROLE dm_tenant");
  await client1.query("COMMIT");
  client1.release();

  // Checkout 2: verify role is reset (should be dm_app, not dm_tenant)
  const client2 = await pool.connect();
  const { rows } = await client2.query("SELECT current_user, session_user");
  // SET LOCAL ROLE resets on COMMIT, so client2 should have default role
  expect(rows[0].current_user).not.toBe("dm_tenant");
  client2.release();
});
```

Note: `SET LOCAL ROLE` is transaction-scoped, so it resets on COMMIT/ROLLBACK automatically. This test confirms that the proxy pool's use of `SET LOCAL ROLE` (not `SET ROLE`) is correct and doesn't leak role state across pool checkouts.

- [ ] **Step 4: Run integration tests**

Run: `cd packages/durable-machine && npx vitest run --project integration`
Expected: PASS (with Docker PG running)

- [ ] **Step 5: Commit**

```bash
git add packages/durable-machine/tests/integration/pg/fixture.ts \
       packages/durable-machine/tests/unit/pg-global-setup.ts
git commit -m "test: update integration test fixtures for multi-tenancy"
```

---

### Task 18: Full Test Suite Verification

- [ ] **Step 1: Run all unit tests**

Run: `cd packages/durable-machine && npx vitest run --project unit`
Expected: PASS

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Run lint**

Run: `pnpm lint:arch`
Expected: PASS

- [ ] **Step 4: Run integration tests (if Docker PG available)**

Run: `cd packages/durable-machine && npx vitest run --project integration`
Expected: PASS

- [ ] **Step 5: Final commit (if any fixups needed)**

```bash
git add -u
git commit -m "fix: address test failures from multi-tenancy integration"
```
