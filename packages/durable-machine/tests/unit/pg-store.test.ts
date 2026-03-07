import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createStore } from "../../src/pg/store.js";
import type { PgStore } from "../../src/pg/store.js";
import { sendMachineEvent, sendMachineEventBatch } from "../../src/pg/client.js";

const TEST_DB_URL =
  process.env.PG_TEST_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

describe("PgStore", () => {
  let pool: pg.Pool;
  let store: PgStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    store = createStore({ pool, useListenNotify: false });
  });

  afterAll(async () => {
    await store.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE machine_instances CASCADE");
  });

  // ── Instance CRUD ─────────────────────────────────────────────────────

  it("createInstance + getInstance round-trip", async () => {
    await store.createInstance(
      "test-1",
      "orderMachine",
      "pending",
      { orderId: "o1", total: 50 },
      { orderId: "o1", total: 50 },
    );

    const row = await store.getInstance("test-1");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("test-1");
    expect(row!.machineName).toBe("orderMachine");
    expect(row!.stateValue).toBe("pending");
    expect(row!.context).toMatchObject({ orderId: "o1", total: 50 });
    expect(row!.status).toBe("running");
    expect(row!.firedDelays).toEqual([]);
    expect(row!.wakeAt).toBeNull();
  });

  it("getInstance returns null for missing id", async () => {
    const row = await store.getInstance("nonexistent");
    expect(row).toBeNull();
  });

  it("updateInstance partial patch", async () => {
    await store.createInstance(
      "test-2",
      "orderMachine",
      "pending",
      { orderId: "o2" },
      null,
    );

    await store.updateInstance("test-2", {
      stateValue: "paid",
      context: { orderId: "o2", chargeId: "ch_1" },
    });

    const row = await store.getInstance("test-2");
    expect(row!.stateValue).toBe("paid");
    expect(row!.context).toMatchObject({ orderId: "o2", chargeId: "ch_1" });
    expect(row!.status).toBe("running");
  });

  it("listInstances with machineName filter", async () => {
    await store.createInstance("list-1", "machineA", "idle", {}, null);
    await store.createInstance("list-2", "machineB", "idle", {}, null);
    await store.createInstance("list-3", "machineA", "active", {}, null);

    const results = await store.listInstances({ machineName: "machineA" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.machineName === "machineA")).toBe(true);
  });

  it("listInstances with status filter", async () => {
    await store.createInstance("list-4", "m1", "idle", {}, null);
    await store.updateInstance("list-4", { status: "done" });
    await store.createInstance("list-5", "m1", "idle", {}, null);

    const results = await store.listInstances({ status: "running" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("list-5");
  });

  // ── Locking ───────────────────────────────────────────────────────────

  it("lockAndGetInstance returns row within transaction", async () => {
    await store.createInstance("lock-1", "m1", "idle", {}, null);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const row = await store.lockAndGetInstance(client, "lock-1");
      expect(row).not.toBeNull();
      expect(row!.id).toBe("lock-1");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  // ── Messages ──────────────────────────────────────────────────────────

  it("sendMessage + consumeNextMessage FIFO ordering", async () => {
    await store.createInstance("msg-1", "m1", "idle", {}, null);

    await store.sendMessage("msg-1", { type: "A" });
    await store.sendMessage("msg-1", { type: "B" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const first = await store.consumeNextMessage(client, "msg-1");
      expect(first).not.toBeNull();
      expect(first!.payload).toMatchObject({ type: "A" });
      await client.query("COMMIT");

      await client.query("BEGIN");
      const second = await store.consumeNextMessage(client, "msg-1");
      expect(second).not.toBeNull();
      expect(second!.payload).toMatchObject({ type: "B" });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("consumeNextMessage returns null when no messages", async () => {
    await store.createInstance("msg-2", "m1", "idle", {}, null);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const msg = await store.consumeNextMessage(client, "msg-2");
      expect(msg).toBeNull();
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  // ── Invoke Results ────────────────────────────────────────────────────

  it("recordInvokeResult + getInvokeResult round-trip", async () => {
    await store.createInstance("inv-1", "m1", "idle", {}, null);

    await store.recordInvokeResult(
      "inv-1",
      "invoke:processPayment",
      { chargeId: "ch_1" },
      undefined,
      1000,
      2000,
    );

    const result = await store.getInvokeResult("inv-1", "invoke:processPayment");
    expect(result).not.toBeNull();
    expect(result!.output).toMatchObject({ chargeId: "ch_1" });
    expect(result!.error).toBeNull();
  });

  it("recordInvokeResult idempotent (ON CONFLICT DO NOTHING)", async () => {
    await store.createInstance("inv-2", "m1", "idle", {}, null);

    await store.recordInvokeResult("inv-2", "step-1", { a: 1 });
    await store.recordInvokeResult("inv-2", "step-1", { a: 2 });

    const result = await store.getInvokeResult("inv-2", "step-1");
    expect(result!.output).toMatchObject({ a: 1 });
  });

  it("listInvokeResults returns StepInfo[]", async () => {
    await store.createInstance("inv-3", "m1", "idle", {}, null);

    await store.recordInvokeResult("inv-3", "invoke:a", { r: 1 }, undefined, 100, 200);
    await store.recordInvokeResult("inv-3", "invoke:b", { r: 2 }, undefined, 300, 400);

    const steps = await store.listInvokeResults("inv-3");
    expect(steps).toHaveLength(2);
    expect(steps[0].name).toBe("invoke:a");
    expect(steps[0].startedAtEpochMs).toBe(100);
    expect(steps[0].completedAtEpochMs).toBe(200);
    expect(steps[1].name).toBe("invoke:b");
  });

  // ── Transition Log ────────────────────────────────────────────────────

  it("appendTransition + getTransitions ordered by seq", async () => {
    await store.createInstance("trans-1", "m1", "idle", {}, null);

    await store.appendTransition("trans-1", null, "pending", null, 1000);
    await store.appendTransition("trans-1", "pending", "paid", "PAY", 2000);
    await store.appendTransition("trans-1", "paid", "delivered", "SHIP", 3000);

    const transitions = await store.getTransitions("trans-1");
    expect(transitions).toHaveLength(3);
    expect(transitions[0].from).toBeNull();
    expect(transitions[0].to).toBe("pending");
    expect(transitions[1].from).toBe("pending");
    expect(transitions[1].to).toBe("paid");
    expect(transitions[2].ts).toBe(3000);
  });

  // ── Schema Idempotency ────────────────────────────────────────────────

  it("ensureSchema is idempotent (safe to call twice)", async () => {
    await store.ensureSchema();
    await store.ensureSchema();
    // No error = success
  });

  // ── sendMachineEventBatch (pg/client.ts) ─────────────────────────────

  describe("sendMachineEventBatch", () => {
    it("inserts multiple events in a single call", async () => {
      await store.createInstance("batch-1", "m1", "idle", {}, null);
      await store.createInstance("batch-2", "m1", "idle", {}, null);

      await sendMachineEventBatch(pool, [
        { workflowId: "batch-1", event: { type: "A" } },
        { workflowId: "batch-2", event: { type: "B" } },
        { workflowId: "batch-1", event: { type: "C" } },
      ]);

      const { rows } = await pool.query(
        `SELECT instance_id, topic, payload FROM machine_messages
         WHERE instance_id IN ('batch-1', 'batch-2') ORDER BY instance_id, payload->>'type'`,
      );
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ instance_id: "batch-1", topic: "event", payload: { type: "A" } });
      expect(rows[1]).toMatchObject({ instance_id: "batch-1", topic: "event", payload: { type: "C" } });
      expect(rows[2]).toMatchObject({ instance_id: "batch-2", topic: "event", payload: { type: "B" } });
    });

    it("is a no-op for empty array", async () => {
      const { rows: before } = await pool.query("SELECT count(*) FROM machine_messages");
      await sendMachineEventBatch(pool, []);
      const { rows: after } = await pool.query("SELECT count(*) FROM machine_messages");
      expect(after[0].count).toBe(before[0].count);
    });

    it("produces same rows as individual sendMachineEvent calls", async () => {
      await store.createInstance("cmp-1", "m1", "idle", {}, null);

      await sendMachineEvent(pool, "cmp-1", { type: "X" });
      await sendMachineEvent(pool, "cmp-1", { type: "Y" });

      await sendMachineEventBatch(pool, [
        { workflowId: "cmp-1", event: { type: "Z" } },
      ]);

      const { rows } = await pool.query(
        `SELECT topic, payload FROM machine_messages
         WHERE instance_id = 'cmp-1' ORDER BY payload->>'type'`,
      );
      expect(rows).toHaveLength(3);
      expect(rows.every((r: any) => r.topic === "event")).toBe(true);
    });
  });
});
