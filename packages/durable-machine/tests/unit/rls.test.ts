import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createStore } from "../../src/pg/store.js";
import { createPgLitePool } from "../fixtures/pglite-pool.js";
import { uuidv7 } from "../../src/uuidv7.js";
import type { PgStore } from "../../src/pg/store-types.js";

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

  it("dm_tenant with empty GUC sees zero rows", async () => {
    await pool.query("SET ROLE dm_tenant");
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
    await pool.query("SET ROLE dm_admin");
    const allInstances = await store.listInstances();
    const instanceA = allInstances.find((r) => r.tenantId === tenantA)!;
    const instanceB = allInstances.find((r) => r.tenantId === tenantB)!;

    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantA] });
    await store.appendEvent(instanceA.id, { type: "EVT_A" });
    await pool.query({ text: `SELECT set_config('app.tenant_id', $1, false)`, values: [tenantB] });
    await store.appendEvent(instanceB.id, { type: "EVT_B" });
    await pool.query("RESET ROLE");

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
});
