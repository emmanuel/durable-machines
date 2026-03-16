import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createStore } from "../../src/pg/store.js";
import type { PgStore } from "../../src/pg/store.js";
import { sendMachineEvent, sendMachineEventBatch } from "../../src/pg/client.js";
import { createPgLitePool } from "../fixtures/pglite-pool.js";
import { uuidv7 } from "../../src/uuidv7.js";

describe("event_log idempotency dedup", () => {
  let db: PGlite;
  let pool: ReturnType<typeof createPgLitePool>;
  let store: PgStore;
  let testTenantId: string;

  beforeAll(async () => {
    db = new PGlite();
    pool = createPgLitePool(db);
    store = createStore({ pool, useListenNotify: false });
    await store.ensureSchema();

    testTenantId = uuidv7();
    const now = Date.now();
    await pool.query({
      text: `INSERT INTO tenants (id, jwt_iss, jwt_aud, jwks_url, name, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      values: [testTenantId, "dedup-iss", "dedup-aud", "https://example.com/.well-known/jwks.json", "Dedup Tenant", now, now],
    });
  });

  afterAll(async () => {
    await store.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE machine_instances CASCADE");
    await pool.query({
      text: `SELECT set_config('app.tenant_id', $1, false)`,
      values: [testTenantId],
    });
  });

  async function createTestInstance(): Promise<string> {
    const id = uuidv7();
    await store.createInstance({
      id,
      machineName: "testMachine",
      stateValue: "idle",
      context: {},
      input: null,
    });
    return id;
  }

  async function countEvents(instanceId: string): Promise<number> {
    const { rows } = await pool.query({
      text: "SELECT count(*)::int AS cnt FROM event_log WHERE instance_id = $1",
      values: [instanceId],
    });
    return rows[0].cnt;
  }

  it("deduplicates events with same (instance_id, idempotency_key)", async () => {
    const id = await createTestInstance();
    const event = { type: "TEST" };

    await sendMachineEvent(pool, id, event, "key-1");
    await sendMachineEvent(pool, id, event, "key-1");

    expect(await countEvents(id)).toBe(1);
  });

  it("inserts both events when idempotency_key is null", async () => {
    const id = await createTestInstance();
    const event = { type: "TEST" };

    await sendMachineEvent(pool, id, event);
    await sendMachineEvent(pool, id, event);

    expect(await countEvents(id)).toBe(2);
  });

  it("inserts both events when idempotency_keys differ", async () => {
    const id = await createTestInstance();
    const event = { type: "TEST" };

    await sendMachineEvent(pool, id, event, "key-a");
    await sendMachineEvent(pool, id, event, "key-b");

    expect(await countEvents(id)).toBe(2);
  });

  it("allows same key for different instance_ids", async () => {
    const id1 = await createTestInstance();
    const id2 = await createTestInstance();
    const event = { type: "TEST" };

    await sendMachineEvent(pool, id1, event, "shared-key");
    await sendMachineEvent(pool, id2, event, "shared-key");

    expect(await countEvents(id1)).toBe(1);
    expect(await countEvents(id2)).toBe(1);
  });

  it("deduplicates within sendMachineEventBatch", async () => {
    const id = await createTestInstance();

    await sendMachineEventBatch(pool, [
      { workflowId: id, event: { type: "A" }, idempotencyKey: "batch-key" },
      { workflowId: id, event: { type: "B" }, idempotencyKey: "batch-key" },
      { workflowId: id, event: { type: "C" }, idempotencyKey: "unique-key" },
    ]);

    expect(await countEvents(id)).toBe(2);
  });

  it("sendMachineEvent with key then same key is no-op", async () => {
    const id = await createTestInstance();

    await sendMachineEvent(pool, id, { type: "FIRST" }, "dedup-key");
    await sendMachineEvent(pool, id, { type: "SECOND" }, "dedup-key");

    const log = await store.getEventLog(id);
    expect(log).toHaveLength(1);
    expect((log[0].payload as any).type).toBe("FIRST");
  });

  it("appendEvent (internal) passes null key — no dedup", async () => {
    const id = await createTestInstance();

    await store.appendEvent(id, { type: "INTERNAL_1" }, "event");
    await store.appendEvent(id, { type: "INTERNAL_2" }, "event");

    expect(await countEvents(id)).toBe(2);
  });
});
