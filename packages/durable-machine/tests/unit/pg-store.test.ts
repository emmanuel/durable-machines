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
    await store.createInstance({
      id: "test-1",
      machineName: "orderMachine",
      stateValue: "pending",
      context: { orderId: "o1", total: 50 },
      input: { orderId: "o1", total: 50 },
    });

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

  it("finalizeInstance updates all fields", async () => {
    await store.createInstance({
      id: "test-2",
      machineName: "orderMachine",
      stateValue: "pending",
      context: { orderId: "o2" },
      input: null,
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await store.finalizeInstance({
        client, instanceId: "test-2",
        stateValue: "paid", context: { orderId: "o2", chargeId: "ch_1" },
        wakeAt: null, wakeEvent: null, firedDelays: [], status: "running", eventCursor: 0,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const row = await store.getInstance("test-2");
    expect(row!.stateValue).toBe("paid");
    expect(row!.context).toMatchObject({ orderId: "o2", chargeId: "ch_1" });
    expect(row!.status).toBe("running");
  });

  it("listInstances with machineName filter", async () => {
    await store.createInstance({ id: "list-1", machineName: "machineA", stateValue: "idle", context: {}, input: null });
    await store.createInstance({ id: "list-2", machineName: "machineB", stateValue: "idle", context: {}, input: null });
    await store.createInstance({ id: "list-3", machineName: "machineA", stateValue: "active", context: {}, input: null });

    const results = await store.listInstances({ machineName: "machineA" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.machineName === "machineA")).toBe(true);
  });

  it("listInstances with status filter", async () => {
    await store.createInstance({ id: "list-4", machineName: "m1", stateValue: "idle", context: {}, input: null });
    await store.updateInstanceStatus("list-4", "done");
    await store.createInstance({ id: "list-5", machineName: "m1", stateValue: "idle", context: {}, input: null });

    const results = await store.listInstances({ status: "running" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("list-5");
  });

  // ── Locking ───────────────────────────────────────────────────────────

  it("lockAndGetInstance returns row within transaction", async () => {
    await store.createInstance({ id: "lock-1", machineName: "m1", stateValue: "idle", context: {}, input: null });

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

  // ── Event Log ───────────────────────────────────────────────────────

  it("appendEvent + getEventLog round-trip", async () => {
    await store.createInstance({ id: "evlog-1", machineName: "m1", stateValue: "idle", context: {}, input: null });

    const { seq: seq1 } = await store.appendEvent("evlog-1", { type: "A" });
    const { seq: seq2 } = await store.appendEvent("evlog-1", { type: "B" });

    expect(seq2).toBeGreaterThan(seq1);

    const log = await store.getEventLog("evlog-1");
    expect(log).toHaveLength(2);
    expect(log[0].payload).toMatchObject({ type: "A" });
    expect(log[1].payload).toMatchObject({ type: "B" });
    expect(log[0].topic).toBe("event");
  });

  it("appendEvent with custom topic and source", async () => {
    await store.createInstance({ id: "evlog-2", machineName: "m1", stateValue: "idle", context: {}, input: null });

    await store.appendEvent("evlog-2", { type: "TIMEOUT" }, "timeout", "system:timeout");

    const log = await store.getEventLog("evlog-2");
    expect(log).toHaveLength(1);
    expect(log[0].topic).toBe("timeout");
    expect(log[0].source).toBe("system:timeout");
  });

  it("getEventLog returns empty array when no events", async () => {
    await store.createInstance({ id: "evlog-3", machineName: "m1", stateValue: "idle", context: {}, input: null });
    const log = await store.getEventLog("evlog-3");
    expect(log).toHaveLength(0);
  });

  it("getEventLog supports afterSeq and limit", async () => {
    await store.createInstance({ id: "evlog-4", machineName: "m1", stateValue: "idle", context: {}, input: null });

    await store.appendEvent("evlog-4", { type: "A" });
    const { seq: seq2 } = await store.appendEvent("evlog-4", { type: "B" });
    await store.appendEvent("evlog-4", { type: "C" });

    const afterFirst = await store.getEventLog("evlog-4", { afterSeq: seq2 - 1 });
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst[0].payload).toMatchObject({ type: "B" });

    const limited = await store.getEventLog("evlog-4", { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].payload).toMatchObject({ type: "A" });
  });

  it("lockAndPeekEvent returns row + next unconsumed event", async () => {
    await store.createInstance({ id: "peek-1", machineName: "m1", stateValue: "idle", context: {}, input: null });
    await store.appendEvent("peek-1", { type: "X" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await store.lockAndPeekEvent(client, "peek-1");
      expect(result).not.toBeNull();
      expect(result!.row.id).toBe("peek-1");
      expect(result!.nextEvent).not.toBeNull();
      expect(result!.nextEvent!.payload).toMatchObject({ type: "X" });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("lockAndPeekEvent returns null nextEvent when no unconsumed events", async () => {
    await store.createInstance({ id: "peek-2", machineName: "m1", stateValue: "idle", context: {}, input: null });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await store.lockAndPeekEvent(client, "peek-2");
      expect(result).not.toBeNull();
      expect(result!.nextEvent).toBeNull();
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("lockAndPeekEvent returns null for missing instance", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await store.lockAndPeekEvent(client, "nonexistent");
      expect(result).toBeNull();
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("lockAndPeekEvent respects event_cursor", async () => {
    await store.createInstance({ id: "peek-3", machineName: "m1", stateValue: "idle", context: {}, input: null });
    const { seq: seq1 } = await store.appendEvent("peek-3", { type: "A" });
    await store.appendEvent("peek-3", { type: "B" });

    // Advance cursor past first event using finalizeInstance
    const client0 = await pool.connect();
    try {
      await client0.query("BEGIN");
      await store.finalizeInstance({ client: client0, instanceId: "peek-3", stateValue: "idle", context: {}, wakeAt: null, wakeEvent: null, firedDelays: [], status: "running", eventCursor: seq1 });
      await client0.query("COMMIT");
    } finally {
      client0.release();
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await store.lockAndPeekEvent(client, "peek-3");
      expect(result).not.toBeNull();
      expect(result!.nextEvent).not.toBeNull();
      expect(result!.nextEvent!.payload).toMatchObject({ type: "B" });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  // ── Invoke Results ────────────────────────────────────────────────────

  it("recordInvokeResult + getInvokeResult round-trip", async () => {
    await store.createInstance({ id: "inv-1", machineName: "m1", stateValue: "idle", context: {}, input: null });

    await store.recordInvokeResult({
      instanceId: "inv-1",
      stepKey: "invoke:processPayment",
      output: { chargeId: "ch_1" },
      startedAt: 1000,
      completedAt: 2000,
    });

    const result = await store.getInvokeResult("inv-1", "invoke:processPayment");
    expect(result).not.toBeNull();
    expect(result!.output).toMatchObject({ chargeId: "ch_1" });
    expect(result!.error).toBeNull();
  });

  it("recordInvokeResult idempotent (ON CONFLICT DO NOTHING)", async () => {
    await store.createInstance({ id: "inv-2", machineName: "m1", stateValue: "idle", context: {}, input: null });

    await store.recordInvokeResult({ instanceId: "inv-2", stepKey: "step-1", output: { a: 1 } });
    await store.recordInvokeResult({ instanceId: "inv-2", stepKey: "step-1", output: { a: 2 } });

    const result = await store.getInvokeResult("inv-2", "step-1");
    expect(result!.output).toMatchObject({ a: 1 });
  });

  it("listInvokeResults returns StepInfo[]", async () => {
    await store.createInstance({ id: "inv-3", machineName: "m1", stateValue: "idle", context: {}, input: null });

    await store.recordInvokeResult({ instanceId: "inv-3", stepKey: "invoke:a", output: { r: 1 }, startedAt: 100, completedAt: 200 });
    await store.recordInvokeResult({ instanceId: "inv-3", stepKey: "invoke:b", output: { r: 2 }, startedAt: 300, completedAt: 400 });

    const steps = await store.listInvokeResults("inv-3");
    expect(steps).toHaveLength(2);
    expect(steps[0].name).toBe("invoke:a");
    expect(steps[0].startedAtEpochMs).toBe(100);
    expect(steps[0].completedAtEpochMs).toBe(200);
    expect(steps[1].name).toBe("invoke:b");
  });

  // ── Transition Log ────────────────────────────────────────────────────

  it("appendTransition + getTransitions ordered by seq", async () => {
    await store.createInstance({ id: "trans-1", machineName: "m1", stateValue: "idle", context: {}, input: null });

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
      await store.createInstance({ id: "batch-1", machineName: "m1", stateValue: "idle", context: {}, input: null });
      await store.createInstance({ id: "batch-2", machineName: "m1", stateValue: "idle", context: {}, input: null });

      await sendMachineEventBatch(pool, [
        { workflowId: "batch-1", event: { type: "A" } },
        { workflowId: "batch-2", event: { type: "B" } },
        { workflowId: "batch-1", event: { type: "C" } },
      ]);

      const { rows } = await pool.query(
        `SELECT instance_id, topic, payload FROM event_log
         WHERE instance_id IN ('batch-1', 'batch-2') ORDER BY instance_id, payload->>'type'`,
      );
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ instance_id: "batch-1", topic: "event", payload: { type: "A" } });
      expect(rows[1]).toMatchObject({ instance_id: "batch-1", topic: "event", payload: { type: "C" } });
      expect(rows[2]).toMatchObject({ instance_id: "batch-2", topic: "event", payload: { type: "B" } });
    });

    it("is a no-op for empty array", async () => {
      const { rows: before } = await pool.query("SELECT count(*) FROM event_log");
      await sendMachineEventBatch(pool, []);
      const { rows: after } = await pool.query("SELECT count(*) FROM event_log");
      expect(after[0].count).toBe(before[0].count);
    });

    it("produces same rows as individual sendMachineEvent calls", async () => {
      await store.createInstance({ id: "cmp-1", machineName: "m1", stateValue: "idle", context: {}, input: null });

      await sendMachineEvent(pool, "cmp-1", { type: "X" });
      await sendMachineEvent(pool, "cmp-1", { type: "Y" });

      await sendMachineEventBatch(pool, [
        { workflowId: "cmp-1", event: { type: "Z" } },
      ]);

      const { rows } = await pool.query(
        `SELECT topic, payload FROM event_log
         WHERE instance_id = 'cmp-1' ORDER BY payload->>'type'`,
      );
      expect(rows).toHaveLength(3);
      expect(rows.every((r: any) => r.topic === "event")).toBe(true);
    });
  });
});
