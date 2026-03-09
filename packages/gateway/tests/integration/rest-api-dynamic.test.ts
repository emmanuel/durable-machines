import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, fromPromise } from "xstate";
import { createPgWorkerContext } from "@durable-xstate/worker/pg";
import type { PgWorkerAppContext } from "@durable-xstate/worker/pg";
import { durableState } from "@durable-xstate/durable-machine";
import { createRestApi } from "../../src/rest-api.js";
import type { Hono } from "hono";

// ── Test machine ─────────────────────────────────────────────────────────────

const orderMachine = setup({
  types: {
    context: {} as { orderId: string },
    events: {} as { type: "CONFIRM" } | { type: "CANCEL" },
    input: {} as { orderId: string },
  },
  actors: {
    fulfil: fromPromise(async () => "done"),
  },
}).createMachine({
  id: "rest-order",
  initial: "pending",
  context: ({ input }: { input: { orderId: string } }) => ({ orderId: input.orderId }),
  states: {
    pending: {
      ...durableState(),
      on: { CONFIRM: "confirmed", CANCEL: "cancelled" },
    },
    confirmed: {
      invoke: { src: "fulfil", onDone: "done" },
    },
    cancelled: { type: "final" },
    done: { type: "final" },
  },
});

const invoiceMachine = setup({
  types: {
    context: {} as { amount: number },
    events: {} as { type: "PAY" },
    input: {} as { amount: number },
  },
}).createMachine({
  id: "rest-invoice",
  initial: "open",
  context: ({ input }: { input: { amount: number } }) => ({ amount: input.amount }),
  states: {
    open: {
      ...durableState(),
      on: { PAY: "paid" },
    },
    paid: { type: "final" },
  },
});

// ── Test setup ───────────────────────────────────────────────────────────────

const TEST_DB_URL =
  process.env.PG_TEST_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

let worker: PgWorkerAppContext;
let app: Hono;

beforeAll(async () => {
  worker = createPgWorkerContext({
    databaseUrl: TEST_DB_URL,
    useListenNotify: false,
  });

  // Pass worker.machines directly — the shared registry
  app = createRestApi({ machines: worker.machines as Map<string, any> });

  await worker.start();
  await worker.pool.query("TRUNCATE machine_instances CASCADE");
});

afterAll(async () => {
  await worker.pool.query("TRUNCATE machine_instances CASCADE");
  await worker.pool.end();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("REST API with dynamically registered PG machines", () => {
  it("returns 404 before any machine is registered", async () => {
    const res = await app.request("/machines/rest-order/instances/test-1");
    expect(res.status).toBe(404);
  });

  it("machine becomes accessible after registration", async () => {
    worker.register(orderMachine);

    // Start an instance via REST
    const createRes = await app.request("/machines/rest-order/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId: "dyn-1", input: { orderId: "ORD-001" } }),
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json() as any;
    expect(created.instanceId).toBe("dyn-1");
    expect(created.state).toBe("pending");
    expect(created.context.orderId).toBe("ORD-001");
    expect(created.links.events).toContain("CONFIRM");
    expect(created.links.events).toContain("CANCEL");
  });

  it("read state reflects persisted data", async () => {
    const res = await app.request("/machines/rest-order/instances/dyn-1");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.state).toBe("pending");
    expect(body.context.orderId).toBe("ORD-001");
  });

  it("send event transitions the machine", async () => {
    const res = await app.request("/machines/rest-order/instances/dyn-1/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "CANCEL" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.state).toBe("cancelled");
    expect(body.status).toBe("done");
    expect(body.links.events).toEqual([]);
  });

  it("second machine registered later is also accessible", async () => {
    worker.register(invoiceMachine);

    const createRes = await app.request("/machines/rest-invoice/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId: "inv-1", input: { amount: 99 } }),
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json() as any;
    expect(created.instanceId).toBe("inv-1");
    expect(created.state).toBe("open");
    expect(created.context.amount).toBe(99);
    expect(created.links.events).toEqual(["PAY"]);
  });

  it("list route works for dynamically registered machines", async () => {
    const res = await app.request("/machines/rest-order/instances");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("unregistered machine still returns 404", async () => {
    const res = await app.request("/machines/nonexistent/instances/x");
    expect(res.status).toBe(404);
  });
});
