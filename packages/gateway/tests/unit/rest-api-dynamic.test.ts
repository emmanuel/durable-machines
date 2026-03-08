import { describe, it, expect, vi } from "vitest";
import { createRestApi } from "../../src/rest-api.js";
import type { DurableMachine, DurableMachineHandle, DurableStateSnapshot } from "@durable-xstate/durable-machine";

// ── Helpers ──────────────────────────────────────────────────────────────────

const snapshot = (overrides: Partial<DurableStateSnapshot> = {}): DurableStateSnapshot => ({
  value: "pending",
  context: { orderId: "123" },
  status: "running",
  ...overrides,
});

function mockHandle(): DurableMachineHandle {
  return {
    workflowId: "inst-1",
    send: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue(snapshot()),
    getResult: vi.fn().mockResolvedValue({}),
    getSteps: vi.fn().mockResolvedValue([]),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
}

function mockDurable(_id: string): DurableMachine {
  const handle = mockHandle();
  return {
    start: vi.fn().mockResolvedValue(handle),
    get: vi.fn().mockReturnValue(handle),
    list: vi.fn().mockResolvedValue([]),
    machine: {
      resolveState({ value }: { value: unknown }) {
        return {
          _nodes: [{ on: { NEXT: {} } }],
          value,
        };
      },
    } as unknown as DurableMachine["machine"],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("REST API — dynamic machine registration", () => {
  it("machines registered after createRestApi() are accessible via routes", async () => {
    // Shared registry — same pattern as worker.machines passed to gateway
    const machines = new Map<string, DurableMachine>();

    const app = createRestApi({ machines });

    // No machines registered yet → 404
    const before = await app.request("/machines/order/instances/inst-1");
    expect(before.status).toBe(404);

    // Dynamically register a machine (simulates worker.register())
    machines.set("order", mockDurable("order"));

    // Same route now returns 200
    const after = await app.request("/machines/order/instances/inst-1");
    expect(after.status).toBe(200);
    const body = await after.json() as any;
    expect(body.instanceId).toBe("inst-1");
    expect(body.state).toBe("pending");
    expect(body.links.events).toEqual(["NEXT"]);
  });

  it("multiple machines can be registered incrementally", async () => {
    const machines = new Map<string, DurableMachine>();
    const app = createRestApi({ machines });

    // Register first machine
    machines.set("order", mockDurable("order"));

    const res1 = await app.request("/machines/order/instances/inst-1");
    expect(res1.status).toBe(200);

    // Second machine not yet registered
    const res2a = await app.request("/machines/invoice/instances/inv-1");
    expect(res2a.status).toBe(404);

    // Register second machine
    machines.set("invoice", mockDurable("invoice"));

    const res2b = await app.request("/machines/invoice/instances/inv-1");
    expect(res2b.status).toBe(200);
  });

  it("start route works with dynamically registered machine", async () => {
    const machines = new Map<string, DurableMachine>();
    const app = createRestApi({ machines });

    machines.set("order", mockDurable("order"));

    const res = await app.request("/machines/order/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId: "inst-new", input: { orderId: "456" } }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.instanceId).toBe("inst-new");
  });

  it("list route works with dynamically registered machine", async () => {
    const dm = mockDurable("order");
    (dm.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { workflowId: "inst-1", status: "PENDING", workflowName: "order" },
    ]);

    const machines = new Map<string, DurableMachine>();
    const app = createRestApi({ machines });

    machines.set("order", dm);

    const res = await app.request("/machines/order/instances");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toHaveLength(1);
  });

  it("send event route works with dynamically registered machine", async () => {
    const machines = new Map<string, DurableMachine>();
    const app = createRestApi({ machines });

    const dm = mockDurable("order");
    machines.set("order", dm);

    const res = await app.request("/machines/order/instances/inst-1/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "NEXT" }),
    });

    expect(res.status).toBe(200);
    const handle = dm.get("inst-1");
    expect(handle.send).toHaveBeenCalledWith({ type: "NEXT" });
  });
});
