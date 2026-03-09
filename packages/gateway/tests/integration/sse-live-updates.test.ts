import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, fromPromise, assign } from "xstate";
import { createPgWorkerContext } from "@durable-xstate/durable-machine/pg";
import type { PgWorkerAppContext } from "@durable-xstate/durable-machine/pg";
import { durableState } from "@durable-xstate/durable-machine";
import { createRestApi } from "../../src/rest-api.js";
import { createDashboard } from "../../src/dashboard/index.js";
import { Hono } from "hono";

// ── Test machine ────────────────────────────────────────────────────────────

const sseMachine = setup({
  types: {
    context: {} as { orderId: string; chargeId?: string },
    events: {} as { type: "PAY" } | { type: "CANCEL" },
    input: {} as { orderId: string },
  },
  actors: {
    processPayment: fromPromise(async () => ({ chargeId: "ch_sse_test" })),
  },
}).createMachine({
  id: "sse-test",
  initial: "pending",
  context: ({ input }: { input: { orderId: string } }) => ({
    orderId: input.orderId,
  }),
  states: {
    pending: {
      ...durableState(),
      on: { PAY: "processing", CANCEL: "cancelled" },
    },
    processing: {
      invoke: {
        src: "processPayment",
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

// ── SSE parsing helpers ─────────────────────────────────────────────────────

interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Consume SSE events from a streaming Response until `count` events are
 * collected or `timeoutMs` elapses. Aborts the stream when done.
 */
async function collectSSEEvents(
  res: Response,
  count: number,
  timeoutMs = 10_000,
): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const deadline = Date.now() + timeoutMs;

  try {
    while (events.length < count && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        ),
      ]);

      if (done && !value) break;
      if (value) buffer += decoder.decode(value, { stream: true });

      // Parse complete SSE messages from the buffer
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!; // Keep incomplete message in buffer

      for (const part of parts) {
        if (!part.trim()) continue;
        const lines = part.split("\n");
        let event = "";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (event || data) {
          events.push({ event, data });
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return events;
}

/**
 * Start an SSE connection, wait for the first event, then perform an action
 * and collect subsequent events.
 */
async function sseWithAction(
  app: Hono,
  ssePath: string,
  action: () => Promise<void>,
  totalEvents: number,
  timeoutMs = 10_000,
): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  const reader = (await app.request(ssePath)).body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let actionFired = false;

  const deadline = Date.now() + timeoutMs;

  try {
    while (events.length < totalEvents && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        ),
      ]);

      if (done && !value) break;
      if (value) buffer += decoder.decode(value, { stream: true });

      // Parse SSE messages
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;
      for (const part of parts) {
        if (!part.trim()) continue;
        const lines = part.split("\n");
        let event = "";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (event || data) events.push({ event, data });
      }

      // Fire the action after first event
      if (!actionFired && events.length >= 1) {
        actionFired = true;
        await action();
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return events;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_DB_URL =
  process.env.PG_TEST_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

function post(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForState(
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
let app: Hono;

beforeAll(async () => {
  worker = createPgWorkerContext({
    databaseUrl: TEST_DB_URL,
    useListenNotify: false,
  });

  await worker.start();
  await worker.pool.query("TRUNCATE machine_instances CASCADE");

  worker.register(sseMachine);

  const restApi = createRestApi({
    machines: worker.machines as Map<string, any>,
    basePath: "/api",
  });

  const dashboard = createDashboard({
    machines: worker.machines as Map<string, any>,
    basePath: "/dashboard",
    restBasePath: "/api",
    pollIntervalMs: 200, // Fast polling for tests
  });

  app = new Hono();
  app.route("/", restApi);
  app.route("/dashboard", dashboard);
});

afterAll(async () => {
  await worker.pool.query("TRUNCATE machine_instances CASCADE");
  await worker.store.close();
  await worker.pool.end();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("SSE live updates E2E with PG backend", () => {
  // ── Instance detail SSE ─────────────────────────────────────────────────

  describe("instance detail SSE — /sse/:machineId/:instanceId", () => {
    it("emits initial state event on connect", async () => {
      // Create an instance first
      await post(app, "/api/machines/sse-test/instances", {
        instanceId: "sse-1",
        input: { orderId: "ORD-SSE-1" },
      });

      // Wait for it to be in pending state
      await waitForState(
        app,
        "/api/machines/sse-test/instances/sse-1",
        (b) => b.state === "pending",
      );

      // Connect to SSE and collect the initial event
      const res = await app.request("/dashboard/sse/sse-test/sse-1");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const events = await collectSSEEvents(res, 1, 5_000);
      expect(events.length).toBeGreaterThanOrEqual(1);

      const first = events[0];
      expect(first.event).toBe("state");
      const data = JSON.parse(first.data);
      expect(data.snapshot.value).toBe("pending");
      expect(data.snapshot.context.orderId).toBe("ORD-SSE-1");
      expect(data.availableEvents).toContain("PAY");
      expect(data.availableEvents).toContain("CANCEL");
    });

    it("emits updated state after event is sent", async () => {
      // Create a fresh instance
      await post(app, "/api/machines/sse-test/instances", {
        instanceId: "sse-2",
        input: { orderId: "ORD-SSE-2" },
      });

      await waitForState(
        app,
        "/api/machines/sse-test/instances/sse-2",
        (b) => b.state === "pending",
      );

      // Connect SSE, wait for initial event, then send CANCEL
      const events = await sseWithAction(
        app,
        "/dashboard/sse/sse-test/sse-2",
        async () => {
          await post(app, "/api/machines/sse-test/instances/sse-2/events", {
            type: "CANCEL",
          });
        },
        3, // initial state + updated state + complete
        10_000,
      );

      // Should have at least 2 events: initial pending + final cancelled
      expect(events.length).toBeGreaterThanOrEqual(2);

      // First event should be the pending state
      const initial = JSON.parse(events[0].data);
      expect(initial.snapshot.value).toBe("pending");

      // Find the state event showing cancelled
      const cancelledEvent = events.find((e) => {
        if (e.event !== "state") return false;
        const d = JSON.parse(e.data);
        return d.snapshot.value === "cancelled";
      });
      expect(cancelledEvent).toBeDefined();

      const cancelledData = JSON.parse(cancelledEvent!.data);
      expect(cancelledData.snapshot.status).toBe("done");
      expect(cancelledData.availableEvents).toEqual([]);
    });

    it("emits complete event when machine reaches final state", async () => {
      // Create instance and immediately cancel it
      await post(app, "/api/machines/sse-test/instances", {
        instanceId: "sse-3",
        input: { orderId: "ORD-SSE-3" },
      });
      await waitForState(
        app,
        "/api/machines/sse-test/instances/sse-3",
        (b) => b.state === "pending",
      );

      // Cancel so it reaches final state
      await post(app, "/api/machines/sse-test/instances/sse-3/events", {
        type: "CANCEL",
      });
      await waitForState(
        app,
        "/api/machines/sse-test/instances/sse-3",
        (b) => b.state === "cancelled",
      );

      // Now connect SSE — should get state + complete immediately
      const res = await app.request("/dashboard/sse/sse-test/sse-3");
      const events = await collectSSEEvents(res, 2, 5_000);

      const completeEvent = events.find((e) => e.event === "complete");
      expect(completeEvent).toBeDefined();
      const completeData = JSON.parse(completeEvent!.data);
      expect(completeData.status).toBe("done");
    });

    it("includes event schemas in state updates", async () => {
      // sse-1 is still in pending — connect and check schemas
      const res = await app.request("/dashboard/sse/sse-test/sse-1");
      const events = await collectSSEEvents(res, 1, 5_000);

      const data = JSON.parse(events[0].data);
      // The machine doesn't use durableSetup, so eventSchemas should be empty
      expect(data.eventSchemas).toBeDefined();
    });

    it("tracks invocation through state transitions", async () => {
      // Create instance and trigger invocation via PAY
      await post(app, "/api/machines/sse-test/instances", {
        instanceId: "sse-4",
        input: { orderId: "ORD-SSE-4" },
      });
      await waitForState(
        app,
        "/api/machines/sse-test/instances/sse-4",
        (b) => b.state === "pending",
      );

      const events = await sseWithAction(
        app,
        "/dashboard/sse/sse-test/sse-4",
        async () => {
          await post(app, "/api/machines/sse-test/instances/sse-4/events", {
            type: "PAY",
          });
        },
        3, // initial + paid state + complete
        10_000,
      );

      // Find the paid state event
      const paidEvent = events.find((e) => {
        if (e.event !== "state") return false;
        const d = JSON.parse(e.data);
        return d.snapshot.value === "paid";
      });
      expect(paidEvent).toBeDefined();

      const paidData = JSON.parse(paidEvent!.data);
      expect(paidData.snapshot.context.chargeId).toBe("ch_sse_test");
      expect(paidData.snapshot.status).toBe("done");
    });
  });

  // ── Instance list SSE ───────────────────────────────────────────────────

  describe("instance list SSE — /sse/:machineId", () => {
    it("emits initial instances event on connect", async () => {
      const res = await app.request("/dashboard/sse/sse-test");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const events = await collectSSEEvents(res, 1, 5_000);
      expect(events.length).toBeGreaterThanOrEqual(1);

      const first = events[0];
      expect(first.event).toBe("instances");
      const data = JSON.parse(first.data);
      expect(Array.isArray(data.instances)).toBe(true);
      // Should include instances we created earlier
      expect(data.instances.length).toBeGreaterThanOrEqual(1);
    });

    it("emits updated list after new instance is created", async () => {
      const events = await sseWithAction(
        app,
        "/dashboard/sse/sse-test",
        async () => {
          await post(app, "/api/machines/sse-test/instances", {
            instanceId: "sse-list-new",
            input: { orderId: "ORD-LIST" },
          });
        },
        2,
        10_000,
      );

      // Should eventually see an instances event that includes sse-list-new
      const withNew = events.find((e) => {
        if (e.event !== "instances") return false;
        const d = JSON.parse(e.data);
        return d.instances.some((i: any) => i.workflowId === "sse-list-new");
      });
      expect(withNew).toBeDefined();
    });
  });

  // ── Error cases ─────────────────────────────────────────────────────────

  describe("SSE error cases", () => {
    it("returns 404 for unknown machine SSE", async () => {
      const res = await app.request("/dashboard/sse/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns 404 for unknown machine instance SSE", async () => {
      const res = await app.request("/dashboard/sse/nonexistent/inst-1");
      expect(res.status).toBe(404);
    });
  });
});
