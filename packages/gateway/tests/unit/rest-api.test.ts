import { describe, it, expect, vi } from "vitest";
import { createRestApi } from "../../src/rest-api.js";
import { DurableMachineError } from "@durable-xstate/durable-machine";
import type { DurableMachine, DurableMachineHandle, DurableStateSnapshot } from "@durable-xstate/durable-machine";

// ── Helpers ──────────────────────────────────────────────────────────────────

const snapshot = (overrides: Partial<DurableStateSnapshot> = {}): DurableStateSnapshot => ({
  value: "pending",
  context: { orderId: "123" },
  status: "running",
  ...overrides,
});

function mockHandle(overrides: Partial<DurableMachineHandle> = {}): DurableMachineHandle {
  return {
    workflowId: "inst-1",
    send: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue(snapshot()),
    getResult: vi.fn().mockResolvedValue({ orderId: "123" }),
    getSteps: vi.fn().mockResolvedValue([{ name: "step1", output: "ok", error: undefined }]),
    cancel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockDurable(overrides: Partial<DurableMachine> = {}): DurableMachine {
  const handle = mockHandle();
  return {
    start: vi.fn().mockResolvedValue(handle),
    get: vi.fn().mockReturnValue(handle),
    list: vi.fn().mockResolvedValue([]),
    machine: {
      resolveState({ value }: { value: unknown }) {
        return {
          _nodes: [{ on: { PAY: {}, CANCEL: {} } }],
          value,
        };
      },
    } as unknown as DurableMachine["machine"],
    ...overrides,
  };
}

function makeApp(durable?: DurableMachine, basePath = "") {
  const dm = durable ?? mockDurable();
  return {
    app: createRestApi({
      machines: new Map([["order", dm]]),
      basePath,
    }),
    dm,
  };
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createRestApi", () => {
  describe("POST /machines/:machineId/instances — start", () => {
    it("returns 201 with state response", async () => {
      const { app } = makeApp();

      const res = await app.request(
        "/machines/order/instances",
        json({ instanceId: "inst-1", input: { orderId: "123" } }),
      );

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.instanceId).toBe("inst-1");
      expect(body.state).toBe("pending");
      expect(body.links.self).toContain("/machines/order/instances/inst-1");
    });

    it("returns 404 for unknown machine", async () => {
      const { app } = makeApp();

      const res = await app.request(
        "/machines/unknown/instances",
        json({ instanceId: "inst-1" }),
      );

      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error).toBe("Machine not found");
    });
  });

  describe("GET /machines/:machineId/instances — list", () => {
    it("returns list of instances", async () => {
      const dm = mockDurable();
      (dm.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        { workflowId: "inst-1", status: "PENDING", workflowName: "order" },
      ]);
      const { app } = makeApp(dm);

      const res = await app.request("/machines/order/instances");

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toHaveLength(1);
      expect(body[0].workflowId).toBe("inst-1");
    });

    it("passes status filter to list()", async () => {
      const dm = mockDurable();
      const { app } = makeApp(dm);

      await app.request("/machines/order/instances?status=running");

      expect(dm.list).toHaveBeenCalledWith({ status: "running" });
    });
  });

  describe("GET /machines/:machineId/instances/:instanceId — read state", () => {
    it("returns state response with HATEOAS links", async () => {
      const { app } = makeApp();

      const res = await app.request("/machines/order/instances/inst-1");

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.instanceId).toBe("inst-1");
      expect(body.state).toBe("pending");
      expect(body.links.events).toEqual(["CANCEL", "PAY"]);
    });

    it("returns 404 when getState returns null", async () => {
      const handle = mockHandle({ getState: vi.fn().mockResolvedValue(null) });
      const dm = mockDurable({ get: vi.fn().mockReturnValue(handle) });
      const { app } = makeApp(dm);

      const res = await app.request("/machines/order/instances/inst-1");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /machines/:machineId/instances/:instanceId/events — send event", () => {
    it("sends event and returns updated state", async () => {
      const handle = mockHandle();
      const dm = mockDurable({ get: vi.fn().mockReturnValue(handle) });
      const { app } = makeApp(dm);

      const res = await app.request(
        "/machines/order/instances/inst-1/events",
        json({ type: "PAY" }),
      );

      expect(res.status).toBe(200);
      expect(handle.send).toHaveBeenCalledWith({ type: "PAY" });
      const body = await res.json() as any;
      expect(body.instanceId).toBe("inst-1");
    });
  });

  describe("GET /machines/:machineId/instances/:instanceId/result — read result", () => {
    it("returns result when done", async () => {
      const handle = mockHandle({
        getState: vi.fn().mockResolvedValue(snapshot({ status: "done", context: { total: 42 } })),
      });
      const dm = mockDurable({ get: vi.fn().mockReturnValue(handle) });
      const { app } = makeApp(dm);

      const res = await app.request("/machines/order/instances/inst-1/result");

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.result).toEqual({ total: 42 });
    });

    it("returns 202 when still running", async () => {
      const { app } = makeApp();

      const res = await app.request("/machines/order/instances/inst-1/result");

      expect(res.status).toBe(202);
      const body = await res.json() as any;
      expect(body.status).toBe("running");
    });

    it("returns 500 when errored", async () => {
      const handle = mockHandle({
        getState: vi.fn().mockResolvedValue(snapshot({ status: "error" })),
      });
      const dm = mockDurable({ get: vi.fn().mockReturnValue(handle) });
      const { app } = makeApp(dm);

      const res = await app.request("/machines/order/instances/inst-1/result");

      expect(res.status).toBe(500);
      const body = await res.json() as any;
      expect(body.error).toBe("Instance errored");
    });
  });

  describe("GET /machines/:machineId/instances/:instanceId/steps — list steps", () => {
    it("returns steps array", async () => {
      const { app } = makeApp();

      const res = await app.request("/machines/order/instances/inst-1/steps");

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toEqual([{ name: "step1", output: "ok" }]);
    });
  });

  describe("GET /machines/:machineId/instances/:instanceId/effects — list effects", () => {
    it("returns effects when backend supports them", async () => {
      const effects = [{ id: "e1", effectType: "webhook", status: "completed" }];
      const handle = mockHandle({
        listEffects: vi.fn().mockResolvedValue(effects),
      });
      const dm = mockDurable({ get: vi.fn().mockReturnValue(handle) });
      const { app } = makeApp(dm);

      const res = await app.request("/machines/order/instances/inst-1/effects");

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toEqual(effects);
    });

    it("returns 501 when backend does not support effects", async () => {
      const { app } = makeApp();

      const res = await app.request("/machines/order/instances/inst-1/effects");

      expect(res.status).toBe(501);
      const body = await res.json() as any;
      expect(body.error).toContain("not supported");
    });
  });

  describe("DELETE /machines/:machineId/instances/:instanceId — cancel", () => {
    it("cancels and returns success", async () => {
      const handle = mockHandle();
      const dm = mockDurable({ get: vi.fn().mockReturnValue(handle) });
      const { app } = makeApp(dm);

      const res = await app.request("/machines/order/instances/inst-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(handle.cancel).toHaveBeenCalled();
      const body = await res.json() as any;
      expect(body.cancelled).toBe(true);
    });
  });

  describe("basePath", () => {
    it("prefixes all routes", async () => {
      const { app } = makeApp(undefined, "/api/v1");

      const res = await app.request("/api/v1/machines/order/instances/inst-1");

      expect(res.status).toBe(200);
    });

    it("non-prefixed path returns 404", async () => {
      const { app } = makeApp(undefined, "/api/v1");

      const res = await app.request("/machines/order/instances/inst-1");

      expect(res.status).toBe(404);
    });
  });

  describe("error handler", () => {
    it("maps DurableMachineError 'not found' to 404", async () => {
      const handle = mockHandle({
        getState: vi.fn().mockRejectedValue(new DurableMachineError("Instance not found")),
      });
      const dm = mockDurable({ get: vi.fn().mockReturnValue(handle) });
      const { app } = makeApp(dm);

      const res = await app.request("/machines/order/instances/inst-1");

      expect(res.status).toBe(404);
    });

    it("maps DurableMachineError 'already exists' to 409", async () => {
      const dm = mockDurable({
        start: vi.fn().mockRejectedValue(new DurableMachineError("Instance already exists")),
      });
      const { app } = makeApp(dm);

      const res = await app.request(
        "/machines/order/instances",
        json({ instanceId: "inst-1" }),
      );

      expect(res.status).toBe(409);
    });

    it("maps unknown errors to 500", async () => {
      const handle = mockHandle({
        getState: vi.fn().mockRejectedValue(new Error("boom")),
      });
      const dm = mockDurable({ get: vi.fn().mockReturnValue(handle) });
      const { app } = makeApp(dm);

      const res = await app.request("/machines/order/instances/inst-1");

      expect(res.status).toBe(500);
      const body = await res.json() as any;
      expect(body.error).toBe("Internal server error");
    });
  });

  describe("shorthand mode", () => {
    function makeShorthandApp(durable?: DurableMachine) {
      const dm = durable ?? mockDurable();
      return {
        app: createRestApi({
          machines: new Map([["order", dm]]),
          shorthand: true,
        }),
        dm,
      };
    }

    it("GET /:instanceId reads state", async () => {
      const { app } = makeShorthandApp();

      const res = await app.request("/inst-1");

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.instanceId).toBe("inst-1");
    });

    it("POST /:instanceId starts instance", async () => {
      const { app, dm } = makeShorthandApp();

      const res = await app.request("/inst-1", json({ input: { orderId: "123" } }));

      expect(res.status).toBe(201);
      expect(dm.start).toHaveBeenCalledWith("inst-1", { orderId: "123" });
    });

    it("POST /:instanceId/:event sends event", async () => {
      const handle = mockHandle();
      const dm = mockDurable({ get: vi.fn().mockReturnValue(handle) });
      const { app } = makeShorthandApp(dm);

      const res = await app.request("/inst-1/PAY", { method: "POST" });

      expect(res.status).toBe(200);
      expect(handle.send).toHaveBeenCalledWith({ type: "PAY" });
    });

    it("throws if more than one machine", () => {
      expect(() =>
        createRestApi({
          machines: new Map([
            ["order", mockDurable()],
            ["invoice", mockDurable()],
          ]),
          shorthand: true,
        }),
      ).toThrow("Shorthand mode requires exactly one machine");
    });
  });
});
