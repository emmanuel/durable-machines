import { describe, it, expect, vi } from "vitest";
import { createDashboard } from "../../../src/dashboard/index.js";
import type {
  DurableMachine,
  DurableMachineHandle,
  DurableStateSnapshot,
  StepInfo,
  TransitionRecord,
} from "@durable-machines/machine";

// ── Mock Factories ──────────────────────────────────────────────────────────

function snapshot(
  overrides: Partial<DurableStateSnapshot> = {},
): DurableStateSnapshot {
  return {
    value: "idle",
    context: { count: 0 },
    status: "running",
    ...overrides,
  };
}

function mockHandle(
  overrides: Partial<DurableMachineHandle> = {},
): DurableMachineHandle {
  return {
    workflowId: "inst-1",
    send: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue(snapshot()),
    getResult: vi.fn().mockResolvedValue({}),
    getSteps: vi.fn().mockResolvedValue([]),
    cancel: vi.fn().mockResolvedValue(undefined),
    getTransitions: vi.fn().mockResolvedValue([]),
    listEffects: vi.fn().mockResolvedValue([]),
    getEventLog: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function mockDurable(
  overrides: Partial<DurableMachine> & { handle?: DurableMachineHandle } = {},
): DurableMachine {
  const handle = overrides.handle ?? mockHandle();
  const { handle: _, ...rest } = overrides;
  return {
    start: vi.fn().mockResolvedValue(handle),
    get: vi.fn().mockReturnValue(handle),
    list: vi.fn().mockResolvedValue([
      { workflowId: "inst-1", status: "PENDING", workflowName: "order" },
    ]),
    // Minimal machine mock that resolveState + returns _nodes with on handlers
    machine: {
      id: "order",
      root: {
        states: {
          idle: {
            type: "atomic",
            meta: {},
            invoke: [],
            on: { START: {} },
            always: [],
            after: [],
            states: {},
            path: ["idle"],
          },
        },
        initial: { target: [{ key: "idle" }] },
      },
      resolveState({ value }: { value: unknown }) {
        return {
          _nodes: [{ on: { START: {} } }],
          value,
        };
      },
    } as unknown as DurableMachine["machine"],
    ...rest,
  };
}

function makeApp(
  machines?: Map<string, DurableMachine>,
  opts?: { basePath?: string; restBasePath?: string },
) {
  const registry =
    machines ?? new Map([["order", mockDurable()]]);
  return createDashboard({
    machines: registry,
    basePath: opts?.basePath ?? "/dashboard",
    restBasePath: opts?.restBasePath ?? "",
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("dashboard routes", () => {
  describe("GET / — machine list", () => {
    it("returns HTML listing registered machines", async () => {
      const app = makeApp();
      const res = await app.request("/");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("order");
      expect(html).toContain("Registered Machines");
    });

    it("shows instance count per machine", async () => {
      const dm = mockDurable();
      (dm.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        { workflowId: "a", status: "PENDING", workflowName: "order" },
        { workflowId: "b", status: "SUCCESS", workflowName: "order" },
      ]);

      const app = makeApp(new Map([["order", dm]]));
      const html = await (await app.request("/")).text();
      // Instance count cell should show 2
      expect(html).toContain(">2<");
    });
  });

  describe("GET /machines/:machineId — instance list", () => {
    it("returns instance list for a valid machine", async () => {
      const app = makeApp();
      const res = await app.request("/machines/order");

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("inst-1");
      expect(html).toContain("PENDING");
    });

    it("passes status filter to list()", async () => {
      const dm = mockDurable();
      const app = makeApp(new Map([["order", dm]]));

      await app.request("/machines/order?status=SUCCESS");

      expect(dm.list).toHaveBeenCalledWith({ status: "SUCCESS" });
    });

    it("returns 404 HTML for unknown machine", async () => {
      const app = makeApp();
      const res = await app.request("/machines/nope");

      expect(res.status).toBe(404);
    });
  });

  describe("GET /machines/:machineId/instances/:instanceId — instance detail", () => {
    it("renders the four-panel detail view", async () => {
      const app = makeApp();
      const res = await app.request("/machines/order/instances/inst-1");

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("graph-container");
      expect(html).toContain("activity-feed");
      expect(html).toContain("context-tree");
      expect(html).toContain("event-form");
    });

    it("returns 404 when getState() returns null", async () => {
      const handle = mockHandle({
        getState: vi.fn().mockResolvedValue(null),
      });
      const dm = mockDurable({ handle });
      const app = makeApp(new Map([["order", dm]]));

      const res = await app.request("/machines/order/instances/inst-1");
      expect(res.status).toBe(404);
    });

    it("uses handle.getTransitions() when available", async () => {
      const transitions: TransitionRecord[] = [
        { from: null, to: "idle", event: null, ts: 1000 },
        { from: "idle", to: "active", event: null, ts: 2000 },
        { from: "active", to: "done", event: null, ts: 3000 },
      ];
      const handle = mockHandle({
        getTransitions: vi.fn().mockResolvedValue(transitions),
      });
      const dm = mockDurable({ handle });
      const app = makeApp(new Map([["order", dm]]));

      const html = await (await app.request("/machines/order/instances/inst-1")).text();

      expect(handle.getTransitions).toHaveBeenCalled();
      // The timeline should contain multiple transition entries
      expect(html).toContain("active");
    });

    it("includes effects panel when listEffects() is available", async () => {
      const handle = mockHandle({
        listEffects: vi.fn().mockResolvedValue([
          {
            id: "eff-1",
            effectType: "sendEmail",
            effectPayload: {},
            status: "completed",
            attempts: 1,
            maxAttempts: 3,
            lastError: null,
            createdAt: 1000,
            completedAt: 2000,
          },
        ]),
      });
      const dm = mockDurable({ handle });
      const app = makeApp(new Map([["order", dm]]));

      const html = await (await app.request("/machines/order/instances/inst-1")).text();
      expect(html).toContain("sendEmail");
      expect(html).toContain("Effects");
    });

    it("renders error panel when instance has error status", async () => {
      const handle = mockHandle({
        getState: vi.fn().mockResolvedValue(
          snapshot({ status: "error", context: { error: "Payment failed" } }),
        ),
      });
      const dm = mockDurable({ handle });
      const app = makeApp(new Map([["order", dm]]));

      const html = await (await app.request("/machines/order/instances/inst-1")).text();
      expect(html).toContain("error-panel");
      expect(html).toContain("Payment failed");
    });

    it("renders error panel for failed steps", async () => {
      const handle = mockHandle({
        getSteps: vi.fn().mockResolvedValue([
          {
            name: "chargeCard",
            output: undefined,
            error: "Insufficient funds",
            startedAtEpochMs: 1000,
            completedAtEpochMs: 2000,
          },
        ] satisfies StepInfo[]),
      });
      const dm = mockDurable({ handle });
      const app = makeApp(new Map([["order", dm]]));

      const html = await (await app.request("/machines/order/instances/inst-1")).text();
      expect(html).toContain("error-panel");
      expect(html).toContain("chargeCard");
      expect(html).toContain("Insufficient funds");
    });

    it("does not render error panel when everything is healthy", async () => {
      const app = makeApp();
      const html = await (await app.request("/machines/order/instances/inst-1")).text();
      // The error panel container should be empty (just open+close div, no child panel)
      expect(html).toContain('id="error-panel-container"></div>');
    });

    it("resolves active states from nested compound state values", async () => {
      const handle = mockHandle({
        getState: vi.fn().mockResolvedValue(
          snapshot({ value: { processing: "validating" } }),
        ),
      });
      const dm = mockDurable({ handle });
      const app = makeApp(new Map([["order", dm]]));

      const html = await (await app.request("/machines/order/instances/inst-1")).text();
      // The runtime data JSON should include both the compound and leaf paths
      const match = html.match(/id="runtime-data">([^<]+)/);
      expect(match).not.toBeNull();
      const runtimeData = JSON.parse(match![1]);
      expect(runtimeData.activeStates).toContain("processing");
      expect(runtimeData.activeStates).toContain("processing.validating");
    });

    it("resolves active states from parallel state values", async () => {
      const handle = mockHandle({
        getState: vi.fn().mockResolvedValue(
          snapshot({ value: { upload: "uploading", payment: "charging" } }),
        ),
      });
      const dm = mockDurable({ handle });
      const app = makeApp(new Map([["order", dm]]));

      const html = await (await app.request("/machines/order/instances/inst-1")).text();
      const match = html.match(/id="runtime-data">([^<]+)/);
      const runtimeData = JSON.parse(match![1]);
      expect(runtimeData.activeStates).toEqual(
        expect.arrayContaining([
          "upload",
          "upload.uploading",
          "payment",
          "payment.charging",
        ]),
      );
    });
  });

  describe("GET /machines/:machineId/new — start instance page", () => {
    it("returns start page HTML for a valid machine", async () => {
      const app = makeApp();
      const res = await app.request("/machines/order/new");

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("start-form");
      expect(html).toContain("Instance ID");
    });

    it("returns 404 for unknown machine", async () => {
      const app = makeApp();
      const res = await app.request("/machines/nope/new");

      expect(res.status).toBe(404);
    });

    it("renders textarea fallback when machine has no inputSchema", async () => {
      const app = makeApp();
      const html = await (await app.request("/machines/order/new")).text();
      // No inputSchema → textarea
      expect(html).toContain("<textarea");
    });

    it("renders machine label and description when available", async () => {
      const dm = mockDurable();
      // Add schemas with label/description to the mock machine
      (dm.machine as any).schemas = {
        "xstate-durable": {
          label: "Order Processing",
          description: "Handles order lifecycle",
          events: {},
        },
      };
      const app = makeApp(new Map([["order", dm]]));
      const html = await (await app.request("/machines/order/new")).text();
      expect(html).toContain("Order Processing");
      expect(html).toContain("Handles order lifecycle");
    });
  });

  describe("GET / — machine list with metadata", () => {
    it("shows label, description, and tags when available", async () => {
      const dm = mockDurable();
      (dm.machine as any).schemas = {
        "xstate-durable": {
          label: "Order Flow",
          description: "End-to-end orders",
          tags: ["orders", "payments"],
          events: {},
        },
      };
      const app = makeApp(new Map([["order", dm]]));
      const html = await (await app.request("/")).text();
      expect(html).toContain("Order Flow");
      expect(html).toContain("End-to-end orders");
      expect(html).toContain("orders");
      expect(html).toContain("payments");
    });
  });

  describe("GET /machines/:machineId — instance list", () => {
    it("includes Start New Instance link", async () => {
      const app = makeApp();
      const html = await (await app.request("/machines/order")).text();
      expect(html).toContain("Start New Instance");
      expect(html).toContain("/dashboard/machines/order/new");
    });
  });

  describe("POST /machines/:machineId/instances/:instanceId/send — event sender", () => {
    it("sends event to handle and redirects", async () => {
      const handle = mockHandle();
      const dm = mockDurable({ handle });
      const app = makeApp(new Map([["order", dm]]), {
        basePath: "/dashboard",
      });

      const form = new URLSearchParams();
      form.set("eventType", "START");
      form.set("payload", '{"urgent": true}');

      const res = await app.request("/machines/order/instances/inst-1/send", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/dashboard/machines/order/instances/inst-1");
      expect(handle.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "START", urgent: true }),
      );
    });

    it("redirects without sending when eventType is empty", async () => {
      const handle = mockHandle();
      const dm = mockDurable({ handle });
      const app = makeApp(new Map([["order", dm]]));

      const form = new URLSearchParams();
      form.set("eventType", "");

      const res = await app.request("/machines/order/instances/inst-1/send", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });

      expect(res.status).toBe(302);
      expect(handle.send).not.toHaveBeenCalled();
    });

    it("sends event without payload when JSON is invalid", async () => {
      const handle = mockHandle();
      const dm = mockDurable({ handle });
      const app = makeApp(new Map([["order", dm]]));

      const form = new URLSearchParams();
      form.set("eventType", "GO");
      form.set("payload", "not json");

      await app.request("/machines/order/instances/inst-1/send", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });

      expect(handle.send).toHaveBeenCalledWith({ type: "GO" });
    });
  });
});
