import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, fromPromise, assign } from "xstate";
import { createPgWorkerContext } from "@durable-xstate/worker/pg";
import type { PgWorkerAppContext } from "@durable-xstate/worker/pg";
import { durableState } from "@durable-xstate/durable-machine";
import { createRestApi } from "../../src/rest-api.js";
import type { Hono } from "hono";

// ── Test machine ─────────────────────────────────────────────────────────────

const orderMachine = setup({
  types: {
    context: {} as {
      orderId: string;
      total: number;
      chargeId?: string;
      trackingNumber?: string;
    },
    events: {} as { type: "PAY" } | { type: "SHIP" } | { type: "CANCEL" },
    input: {} as { orderId: string; total: number },
  },
  actors: {
    processPayment: fromPromise(
      async ({ input }: { input: { total: number } }) => {
        return { chargeId: `ch_${input.total}` };
      },
    ),
    shipOrder: fromPromise(
      async ({ input }: { input: { orderId: string } }) => {
        return { trackingNumber: `tr_${input.orderId}` };
      },
    ),
  },
}).createMachine({
  id: "e2e-order",
  initial: "pending",
  context: ({ input }: { input: { orderId: string; total: number } }) => ({
    orderId: input.orderId,
    total: input.total,
  }),
  states: {
    pending: {
      ...durableState(),
      on: { PAY: "processing", CANCEL: "cancelled" },
    },
    processing: {
      invoke: {
        src: "processPayment",
        input: ({ context }: { context: { total: number } }) => ({ total: context.total }),
        onDone: {
          target: "paid",
          actions: assign({
            chargeId: ({ event }) => (event.output as any).chargeId,
          }),
        },
        onError: "paymentFailed",
      },
    },
    paid: {
      ...durableState(),
      on: { SHIP: "shipping" },
    },
    shipping: {
      invoke: {
        src: "shipOrder",
        input: ({ context }: { context: { orderId: string } }) => ({ orderId: context.orderId }),
        onDone: {
          target: "delivered",
          actions: assign({
            trackingNumber: ({ event }) => (event.output as any).trackingNumber,
          }),
        },
        onError: "shipmentFailed",
      },
    },
    delivered: { type: "final" },
    cancelled: { type: "final" },
    paymentFailed: { type: "final" },
    shipmentFailed: { type: "final" },
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_DB_URL =
  process.env.PG_TEST_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

function post(path: string, body: unknown): [string, RequestInit] {
  return [path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }];
}

/** Poll a GET endpoint until the response body matches a predicate. */
async function waitForRestState(
  app: Hono,
  path: string,
  predicate: (body: any) => boolean,
  timeoutMs = 10_000,
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.request(path);
    if (res.status === 200) {
      const body = await res.json() as any;
      if (predicate(body)) return body;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for state at ${path}`);
}

// ── Setup ────────────────────────────────────────────────────────────────────

let worker: PgWorkerAppContext;
let app: Hono;

beforeAll(async () => {
  worker = createPgWorkerContext({
    databaseUrl: TEST_DB_URL,
    useListenNotify: false,
  });

  await worker.start();
  await worker.pool.query("TRUNCATE machine_instances CASCADE");

  worker.register(orderMachine);
  app = createRestApi({
    machines: worker.machines as Map<string, any>,
    basePath: "/api",
  });
});

afterAll(async () => {
  await worker.pool.query("TRUNCATE machine_instances CASCADE");
  await worker.store.close();
  await worker.pool.end();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("REST API end-to-end with PG backend", () => {
  // ── Happy path: full order lifecycle ────────────────────────────────────

  it("start — creates instance in pending state with correct HATEOAS links", async () => {
    const res = await app.request(
      ...post("/api/machines/e2e-order/instances", {
        instanceId: "ord-1",
        input: { orderId: "ORD-100", total: 42 },
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.instanceId).toBe("ord-1");
    expect(body.state).toBe("pending");
    expect(body.context.orderId).toBe("ORD-100");
    expect(body.context.total).toBe(42);
    expect(body.status).toBe("running");
    expect(body.links.self).toBe("/api/machines/e2e-order/instances/ord-1");
    expect(body.links.send).toBe("/api/machines/e2e-order/instances/ord-1/events");
    expect(body.links.events).toEqual(["CANCEL", "PAY"]);
    expect(body.links.result).toBe("/api/machines/e2e-order/instances/ord-1/result");
    expect(body.links.steps).toBe("/api/machines/e2e-order/instances/ord-1/steps");
    expect(body.links.effects).toBe("/api/machines/e2e-order/instances/ord-1/effects");
  });

  it("read — returns persisted state via GET", async () => {
    const res = await app.request("/api/machines/e2e-order/instances/ord-1");

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.state).toBe("pending");
    expect(body.context.orderId).toBe("ORD-100");
  });

  it("result — returns 202 while still running", async () => {
    const res = await app.request("/api/machines/e2e-order/instances/ord-1/result");

    expect(res.status).toBe(202);
    const body = await res.json() as any;
    expect(body.status).toBe("running");
  });

  it("send PAY — triggers payment invocation and transitions to paid", async () => {
    // Send the PAY event
    const sendRes = await app.request(
      ...post("/api/machines/e2e-order/instances/ord-1/events", { type: "PAY" }),
    );
    expect(sendRes.status).toBe(200);

    // The invocation runs async — poll until state reaches "paid"
    const body = await waitForRestState(
      app,
      "/api/machines/e2e-order/instances/ord-1",
      (b) => b.state === "paid",
    );

    expect(body.state).toBe("paid");
    expect(body.context.chargeId).toBe("ch_42");
    // Available events should now be only SHIP
    expect(body.links.events).toEqual(["SHIP"]);
  });

  it("send SHIP — triggers shipment invocation and transitions to delivered", async () => {
    const sendRes = await app.request(
      ...post("/api/machines/e2e-order/instances/ord-1/events", { type: "SHIP" }),
    );
    expect(sendRes.status).toBe(200);

    // Poll until state reaches "delivered" (final)
    const body = await waitForRestState(
      app,
      "/api/machines/e2e-order/instances/ord-1",
      (b) => b.state === "delivered",
    );

    expect(body.state).toBe("delivered");
    expect(body.status).toBe("done");
    expect(body.context.trackingNumber).toBe("tr_ORD-100");
    // No events in a final state
    expect(body.links.events).toEqual([]);
  });

  it("result — returns final context when done", async () => {
    const res = await app.request("/api/machines/e2e-order/instances/ord-1/result");

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.result.orderId).toBe("ORD-100");
    expect(body.result.chargeId).toBe("ch_42");
    expect(body.result.trackingNumber).toBe("tr_ORD-100");
  });

  it("steps — returns executed durable steps", async () => {
    const res = await app.request("/api/machines/e2e-order/instances/ord-1/steps");

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  // ── List ────────────────────────────────────────────────────────────────

  it("list — returns all instances", async () => {
    const res = await app.request("/api/machines/e2e-order/instances");

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBeGreaterThanOrEqual(1);
    const ids = body.map((i: any) => i.workflowId);
    expect(ids).toContain("ord-1");
  });

  // ── Cancel flow ─────────────────────────────────────────────────────────

  it("cancel — cancels a running instance", async () => {
    // Start a second instance to cancel
    await app.request(
      ...post("/api/machines/e2e-order/instances", {
        instanceId: "ord-cancel",
        input: { orderId: "ORD-CANCEL", total: 10 },
      }),
    );

    // Verify it's running
    const before = await app.request("/api/machines/e2e-order/instances/ord-cancel");
    expect(before.status).toBe(200);
    const beforeBody = await before.json() as any;
    expect(beforeBody.state).toBe("pending");

    // Cancel it
    const cancelRes = await app.request("/api/machines/e2e-order/instances/ord-cancel", {
      method: "DELETE",
    });
    expect(cancelRes.status).toBe(200);
    const cancelBody = await cancelRes.json() as any;
    expect(cancelBody.cancelled).toBe(true);
  });

  // ── Error cases ─────────────────────────────────────────────────────────

  it("404 — unknown machine", async () => {
    const res = await app.request("/api/machines/nonexistent/instances/x");
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe("Machine not found");
  });

  it("404 — unknown instance", async () => {
    const res = await app.request("/api/machines/e2e-order/instances/no-such-id");
    expect(res.status).toBe(404);
  });

  it("409 — duplicate instance ID", async () => {
    // ord-1 already exists from the happy path
    const res = await app.request(
      ...post("/api/machines/e2e-order/instances", {
        instanceId: "ord-1",
        input: { orderId: "ORD-DUP", total: 1 },
      }),
    );
    expect(res.status).toBe(409);
  });
});
