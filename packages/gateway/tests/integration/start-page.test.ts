import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fromPromise, assign } from "xstate";
import { createPgWorkerContext } from "@durable-xstate/worker/pg";
import type { PgWorkerAppContext } from "@durable-xstate/worker/pg";
import { durableSetup, durableState } from "@durable-xstate/durable-machine";
import { createRestApi } from "../../src/rest-api.js";
import { createDashboard } from "../../src/dashboard/index.js";
import { Hono } from "hono";

// ── Test machine with full durableSetup() metadata ──────────────────────────

const orderMachine = durableSetup({
  label: "Order Processing",
  description: "Handles order lifecycle from placement to fulfillment",
  tags: ["orders", "payments"],
  events: {
    PAY: { cardToken: "string", amount: "number" },
    CANCEL: {},
  },
  input: {
    orderId: "string",
    total: { type: "number", label: "Total ($)", placeholder: "0.00", helpText: "Amount in USD" },
    priority: { type: "select", options: ["normal", "rush"], defaultValue: "normal" },
  },
  actors: {
    processPayment: fromPromise(
      async ({ input }: { input: { total: number } }) => {
        return { chargeId: `ch_${input.total}` };
      },
    ),
  },
}).createMachine({
  id: "start-page-order",
  initial: "pending",
  context: ({ input }) => ({
    orderId: input.orderId,
    total: input.total,
    priority: input.priority ?? "normal",
  }),
  states: {
    pending: {
      ...durableState(),
      on: {
        PAY: "processing",
        CANCEL: "cancelled",
      },
    },
    processing: {
      invoke: {
        src: "processPayment",
        input: ({ context }) => ({ total: (context as any).total }),
        onDone: {
          target: "paid",
          actions: assign({
            chargeId: ({ event }) => (event.output as any).chargeId,
          }),
        },
        onError: "failed",
      },
    },
    paid: { type: "final" },
    cancelled: { type: "final" },
    failed: { type: "final" },
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Setup ───────────────────────────────────────────────────────────────────

let worker: PgWorkerAppContext;
let restApi: Hono;
let dashboard: Hono;
let combined: Hono;

beforeAll(async () => {
  worker = createPgWorkerContext({
    databaseUrl: TEST_DB_URL,
    useListenNotify: false,
  });

  await worker.start();
  await worker.pool.query("TRUNCATE machine_instances CASCADE");

  worker.register(orderMachine);

  restApi = createRestApi({
    machines: worker.machines as Map<string, any>,
    basePath: "/api",
  });

  dashboard = createDashboard({
    machines: worker.machines as Map<string, any>,
    basePath: "/dashboard",
    restBasePath: "/api",
  });

  // Mount REST API at root (basePath already includes "/api" prefix)
  // Mount dashboard at /dashboard (sub-app routes are relative)
  combined = new Hono();
  combined.route("/", restApi);
  combined.route("/dashboard", dashboard);
});

afterAll(async () => {
  await worker.pool.query("TRUNCATE machine_instances CASCADE");
  await worker.pool.end();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Start page E2E with PG backend", () => {
  // ── Machine list shows metadata ─────────────────────────────────────────

  it("machine list page shows label, description, and tags", async () => {
    const res = await combined.request("/dashboard");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Order Processing");
    expect(html).toContain("Handles order lifecycle from placement to fulfillment");
    expect(html).toContain("orders");
    expect(html).toContain("payments");
  });

  // ── Start page rendering ────────────────────────────────────────────────

  it("GET /:machineId/new renders start page with metadata header", async () => {
    const res = await combined.request("/dashboard/machines/start-page-order/new");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Order Processing");
    expect(html).toContain("Handles order lifecycle from placement to fulfillment");
    expect(html).toContain("start-form");
    expect(html).toContain("Instance ID");
  });

  it("start page renders typed input fields from inputSchema", async () => {
    const html = await (await combined.request("/dashboard/machines/start-page-order/new")).text();

    // orderId: string → text input
    expect(html).toContain('data-field="orderId"');

    // total: number with placeholder and helpText
    expect(html).toContain('data-field="total"');
    expect(html).toContain('placeholder="0.00"');
    expect(html).toContain("Amount in USD");
    expect(html).toContain("Total ($)");

    // priority: select with options
    expect(html).toContain('data-field="priority"');
    expect(html).toContain("normal");
    expect(html).toContain("rush");

    // Default value should be pre-selected
    expect(html).toContain("selected");

    // Should have schema marker
    expect(html).toContain('data-has-schema="true"');
  });

  it("start page has cancel link back to instance list", async () => {
    const html = await (await combined.request("/dashboard/machines/start-page-order/new")).text();
    expect(html).toContain('href="/dashboard/machines/start-page-order"');
    expect(html).toContain("Cancel");
  });

  it("returns 404 for unknown machine start page", async () => {
    const res = await combined.request("/dashboard/machines/nonexistent/new");
    expect(res.status).toBe(404);
  });

  // ── Instance list has Start New Instance link ───────────────────────────

  it("instance list page shows Start New Instance link", async () => {
    const res = await combined.request("/dashboard/machines/start-page-order");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Start New Instance");
    expect(html).toContain("/dashboard/machines/start-page-order/new");
  });

  // ── Full lifecycle: start via REST → verify in dashboard ────────────────

  it("creates instance via REST API with schema-typed input", async () => {
    const res = await combined.request(
      ...post("/api/machines/start-page-order/instances", {
        instanceId: "sp-ord-1",
        input: { orderId: "ORD-SP-100", total: 55.99, priority: "rush" },
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.instanceId).toBe("sp-ord-1");
    expect(body.state).toBe("pending");
    expect(body.context.orderId).toBe("ORD-SP-100");
    expect(body.context.total).toBe(55.99);
    expect(body.context.priority).toBe("rush");
  });

  it("dashboard instance detail shows context from schema-typed input", async () => {
    const res = await combined.request("/dashboard/machines/start-page-order/instances/sp-ord-1");
    expect(res.status).toBe(200);
    const html = await res.text();

    // Detail page should show the instance data
    expect(html).toContain("sp-ord-1");
    expect(html).toContain("ORD-SP-100");
    expect(html).toContain("55.99");
    expect(html).toContain("rush");

    // Should have the graph and panels
    expect(html).toContain("graph-container");
    expect(html).toContain("context-tree");
    expect(html).toContain("event-form");
  });

  it("dashboard detail shows event schemas for available events", async () => {
    const html = await (await combined.request("/dashboard/machines/start-page-order/instances/sp-ord-1")).text();

    // The runtime data JSON should include event schemas
    const match = html.match(/id="runtime-data">([^<]+)/);
    expect(match).not.toBeNull();
    const runtimeData = JSON.parse(match![1]);

    // Event schemas should be present for PAY (has fields)
    expect(runtimeData.eventSchemas).toBeDefined();
    expect(runtimeData.eventSchemas.PAY).toBeDefined();
    expect(runtimeData.eventSchemas.PAY.length).toBe(2);
    // CANCEL has no fields so shouldn't appear in eventSchemas
    expect(runtimeData.eventSchemas.CANCEL).toBeUndefined();

    // Available events should be in the event form dropdown
    expect(html).toContain("PAY");
    expect(html).toContain("CANCEL");
  });

  it("send event → verify state transition in dashboard", async () => {
    // Send PAY event via REST
    const sendRes = await combined.request(
      ...post("/api/machines/start-page-order/instances/sp-ord-1/events", {
        type: "PAY",
        cardToken: "tok_abc",
        amount: 55.99,
      }),
    );
    expect(sendRes.status).toBe(200);

    // Wait for invocation to complete and reach "paid" state
    const body = await waitForRestState(
      combined,
      "/api/machines/start-page-order/instances/sp-ord-1",
      (b) => b.state === "paid",
    );

    expect(body.state).toBe("paid");
    expect(body.context.chargeId).toBe("ch_55.99");

    // Dashboard detail should reflect the final state
    const dashRes = await combined.request("/dashboard/machines/start-page-order/instances/sp-ord-1");
    const html = await dashRes.text();
    expect(html).toContain("ch_55.99");
  });

  it("instance list shows the created instance", async () => {
    const html = await (await combined.request("/dashboard/machines/start-page-order")).text();
    expect(html).toContain("sp-ord-1");
  });
});
