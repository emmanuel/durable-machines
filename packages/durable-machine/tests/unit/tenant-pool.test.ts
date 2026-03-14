import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createStore } from "../../src/pg/store.js";
import { createPgLitePool } from "../fixtures/pglite-pool.js";
import { createTenantPool } from "../../src/pg/tenant-pool.js";
import { uuidv7 } from "../../src/uuidv7.js";
import type { PgStore } from "../../src/pg/store-types.js";

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
