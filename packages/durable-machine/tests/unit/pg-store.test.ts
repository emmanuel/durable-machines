import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createStore } from "../../src/pg/store.js";
import type { PgStore } from "../../src/pg/store.js";
import { sendMachineEvent, sendMachineEventBatch } from "../../src/pg/client.js";
import { createPgLitePool } from "../fixtures/pglite-pool.js";
import { uuidv7 } from "../../src/uuidv7.js";

describe("PgStore", () => {
  let db: PGlite;
  let pool: ReturnType<typeof createPgLitePool>;
  let store: PgStore;

  beforeAll(async () => {
    db = new PGlite();
    pool = createPgLitePool(db);
    store = createStore({ pool, useListenNotify: false });
    await store.ensureSchema();
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
    const id = uuidv7();
    await store.createInstance({
      id,
      machineName: "orderMachine",
      stateValue: "pending",
      context: { orderId: "o1", total: 50 },
      input: { orderId: "o1", total: 50 },
    });

    const row = await store.getInstance(id);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.machineName).toBe("orderMachine");
    expect(row!.stateValue).toBe("pending");
    expect(row!.context).toMatchObject({ orderId: "o1", total: 50 });
    expect(row!.status).toBe("running");
    expect(row!.firedDelays).toEqual([]);
    expect(row!.wakeAt).toBeNull();
  });

  it("getInstance returns null for missing id", async () => {
    const row = await store.getInstance(uuidv7());
    expect(row).toBeNull();
  });

  it("finalizeInstance updates all fields", async () => {
    const id = uuidv7();
    await store.createInstance({
      id,
      machineName: "orderMachine",
      stateValue: "pending",
      context: { orderId: "o2" },
      input: null,
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await store.finalizeInstance({
        client, instanceId: id,
        stateValue: "paid", context: { orderId: "o2", chargeId: "ch_1" },
        wakeAt: null, wakeEvent: null, firedDelays: [], status: "running", eventCursor: 0,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const row = await store.getInstance(id);
    expect(row!.stateValue).toBe("paid");
    expect(row!.context).toMatchObject({ orderId: "o2", chargeId: "ch_1" });
    expect(row!.status).toBe("running");
  });

  it("listInstances with machineName filter", async () => {
    await store.createInstance({ id: uuidv7(), machineName: "machineA", stateValue: "idle", context: {}, input: null });
    await store.createInstance({ id: uuidv7(), machineName: "machineB", stateValue: "idle", context: {}, input: null });
    await store.createInstance({ id: uuidv7(), machineName: "machineA", stateValue: "active", context: {}, input: null });

    const results = await store.listInstances({ machineName: "machineA" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.machineName === "machineA")).toBe(true);
  });

  it("listInstances with status filter", async () => {
    const id4 = uuidv7();
    const id5 = uuidv7();
    await store.createInstance({ id: id4, machineName: "m1", stateValue: "idle", context: {}, input: null });
    await store.updateInstanceStatus(id4, "done");
    await store.createInstance({ id: id5, machineName: "m1", stateValue: "idle", context: {}, input: null });

    const results = await store.listInstances({ status: "running" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(id5);
  });

  // ── Locking ───────────────────────────────────────────────────────────

  it("lockAndGetInstance returns row within transaction", async () => {
    const id = uuidv7();
    await store.createInstance({ id, machineName: "m1", stateValue: "idle", context: {}, input: null });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const row = await store.lockAndGetInstance(client, id);
      expect(row).not.toBeNull();
      expect(row!.id).toBe(id);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  // ── Event Log ───────────────────────────────────────────────────────

  it("appendEvent + getEventLog round-trip", async () => {
    const id = uuidv7();
    await store.createInstance({ id, machineName: "m1", stateValue: "idle", context: {}, input: null });

    const { seq: seq1 } = await store.appendEvent(id, { type: "A" });
    const { seq: seq2 } = await store.appendEvent(id, { type: "B" });

    expect(seq2).toBeGreaterThan(seq1);

    const log = await store.getEventLog(id);
    expect(log).toHaveLength(2);
    expect(log[0].payload).toMatchObject({ type: "A" });
    expect(log[1].payload).toMatchObject({ type: "B" });
    expect(log[0].topic).toBe("event");
  });

  it("appendEvent with custom topic and source", async () => {
    const id = uuidv7();
    await store.createInstance({ id, machineName: "m1", stateValue: "idle", context: {}, input: null });

    await store.appendEvent(id, { type: "TIMEOUT" }, "timeout", "system:timeout");

    const log = await store.getEventLog(id);
    expect(log).toHaveLength(1);
    expect(log[0].topic).toBe("timeout");
    expect(log[0].source).toBe("system:timeout");
  });

  it("getEventLog returns empty array when no events", async () => {
    const id = uuidv7();
    await store.createInstance({ id, machineName: "m1", stateValue: "idle", context: {}, input: null });
    const log = await store.getEventLog(id);
    expect(log).toHaveLength(0);
  });

  it("getEventLog supports afterSeq and limit", async () => {
    const id = uuidv7();
    await store.createInstance({ id, machineName: "m1", stateValue: "idle", context: {}, input: null });

    await store.appendEvent(id, { type: "A" });
    const { seq: seq2 } = await store.appendEvent(id, { type: "B" });
    await store.appendEvent(id, { type: "C" });

    const afterFirst = await store.getEventLog(id, { afterSeq: seq2 - 1 });
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst[0].payload).toMatchObject({ type: "B" });

    const limited = await store.getEventLog(id, { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].payload).toMatchObject({ type: "A" });
  });

  it("lockAndPeekEvent returns row + next unconsumed event", async () => {
    const id = uuidv7();
    await store.createInstance({ id, machineName: "m1", stateValue: "idle", context: {}, input: null });
    await store.appendEvent(id, { type: "X" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await store.lockAndPeekEvent(client, id);
      expect(result).not.toBeNull();
      expect(result!.row.id).toBe(id);
      expect(result!.nextEvent).not.toBeNull();
      expect(result!.nextEvent!.payload).toMatchObject({ type: "X" });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("lockAndPeekEvent returns null nextEvent when no unconsumed events", async () => {
    const id = uuidv7();
    await store.createInstance({ id, machineName: "m1", stateValue: "idle", context: {}, input: null });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await store.lockAndPeekEvent(client, id);
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
      const result = await store.lockAndPeekEvent(client, uuidv7());
      expect(result).toBeNull();
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("lockAndPeekEvent respects event_cursor", async () => {
    const id = uuidv7();
    await store.createInstance({ id, machineName: "m1", stateValue: "idle", context: {}, input: null });
    const { seq: seq1 } = await store.appendEvent(id, { type: "A" });
    await store.appendEvent(id, { type: "B" });

    // Advance cursor past first event using finalizeInstance
    const client0 = await pool.connect();
    try {
      await client0.query("BEGIN");
      await store.finalizeInstance({ client: client0, instanceId: id, stateValue: "idle", context: {}, wakeAt: null, wakeEvent: null, firedDelays: [], status: "running", eventCursor: seq1 });
      await client0.query("COMMIT");
    } finally {
      client0.release();
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await store.lockAndPeekEvent(client, id);
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
    const id = uuidv7();
    await store.createInstance({ id, machineName: "m1", stateValue: "idle", context: {}, input: null });

    await store.recordInvokeResult({
      instanceId: id,
      stepKey: "invoke:processPayment",
      output: { chargeId: "ch_1" },
      startedAt: 1000,
      completedAt: 2000,
    });

    const result = await store.getInvokeResult(id, "invoke:processPayment");
    expect(result).not.toBeNull();
    expect(result!.output).toMatchObject({ chargeId: "ch_1" });
    expect(result!.error).toBeNull();
  });

  it("recordInvokeResult idempotent (ON CONFLICT DO NOTHING)", async () => {
    const id = uuidv7();
    await store.createInstance({ id, machineName: "m1", stateValue: "idle", context: {}, input: null });

    await store.recordInvokeResult({ instanceId: id, stepKey: "step-1", output: { a: 1 } });
    await store.recordInvokeResult({ instanceId: id, stepKey: "step-1", output: { a: 2 } });

    const result = await store.getInvokeResult(id, "step-1");
    expect(result!.output).toMatchObject({ a: 1 });
  });

  it("listInvokeResults returns StepInfo[]", async () => {
    const id = uuidv7();
    await store.createInstance({ id, machineName: "m1", stateValue: "idle", context: {}, input: null });

    await store.recordInvokeResult({ instanceId: id, stepKey: "invoke:a", output: { r: 1 }, startedAt: 100, completedAt: 200 });
    await store.recordInvokeResult({ instanceId: id, stepKey: "invoke:b", output: { r: 2 }, startedAt: 300, completedAt: 400 });

    const steps = await store.listInvokeResults(id);
    expect(steps).toHaveLength(2);
    expect(steps[0].name).toBe("invoke:a");
    expect(steps[0].startedAtEpochMs).toBe(100);
    expect(steps[0].completedAtEpochMs).toBe(200);
    expect(steps[1].name).toBe("invoke:b");
  });

  // ── Transition Log ────────────────────────────────────────────────────

  it("appendTransition + getTransitions ordered by seq", async () => {
    const id = uuidv7();
    await store.createInstance({ id, machineName: "m1", stateValue: "idle", context: {}, input: null });

    await store.appendTransition(id, null, "pending", null, 1000);
    await store.appendTransition(id, "pending", "paid", "PAY", 2000);
    await store.appendTransition(id, "paid", "delivered", "SHIP", 3000);

    const transitions = await store.getTransitions(id);
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
      const id1 = uuidv7();
      const id2 = uuidv7();
      await store.createInstance({ id: id1, machineName: "m1", stateValue: "idle", context: {}, input: null });
      await store.createInstance({ id: id2, machineName: "m1", stateValue: "idle", context: {}, input: null });

      await sendMachineEventBatch(pool, [
        { workflowId: id1, event: { type: "A" } },
        { workflowId: id2, event: { type: "B" } },
        { workflowId: id1, event: { type: "C" } },
      ]);

      const { rows } = await pool.query({
        text: `SELECT instance_id, topic, payload FROM event_log
               WHERE instance_id = ANY($1) ORDER BY instance_id, payload->>'type'`,
        values: [[id1, id2]],
      });
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ instance_id: id1, topic: "event", payload: { type: "A" } });
      expect(rows[1]).toMatchObject({ instance_id: id1, topic: "event", payload: { type: "C" } });
      expect(rows[2]).toMatchObject({ instance_id: id2, topic: "event", payload: { type: "B" } });
    });

    it("is a no-op for empty array", async () => {
      const { rows: before } = await pool.query("SELECT count(*) FROM event_log");
      await sendMachineEventBatch(pool, []);
      const { rows: after } = await pool.query("SELECT count(*) FROM event_log");
      expect(after[0].count).toBe(before[0].count);
    });

    it("produces same rows as individual sendMachineEvent calls", async () => {
      const id = uuidv7();
      await store.createInstance({ id, machineName: "m1", stateValue: "idle", context: {}, input: null });

      await sendMachineEvent(pool, id, { type: "X" });
      await sendMachineEvent(pool, id, { type: "Y" });

      await sendMachineEventBatch(pool, [
        { workflowId: id, event: { type: "Z" } },
      ]);

      const { rows } = await pool.query({
        text: `SELECT topic, payload FROM event_log
               WHERE instance_id = $1 ORDER BY payload->>'type'`,
        values: [id],
      });
      expect(rows).toHaveLength(3);
      expect(rows.every((r: any) => r.topic === "event")).toBe(true);
    });
  });
});
