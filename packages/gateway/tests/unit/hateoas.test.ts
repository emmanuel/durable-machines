import { describe, it, expect } from "vitest";
import { getAvailableEvents, buildLinks, toStateResponse } from "../../src/hateoas.js";
import type { DurableMachine, DurableStateSnapshot } from "@durable-machines/machine";

// ── Mock Machine ──────────────────────────────────────────────────────────

function createMockMachine(eventsByState: Record<string, string[]>): DurableMachine["machine"] {
  return {
    resolveState({ value }: { value: unknown }) {
      const stateStr = typeof value === "string" ? value : JSON.stringify(value);
      const events = eventsByState[stateStr] ?? [];
      const onHandlers: Record<string, unknown> = {};
      for (const e of events) {
        onHandlers[e] = {};
      }
      // Also add some internal xstate events that should be filtered
      onHandlers["xstate.done.actor.foo"] = {};
      return {
        _nodes: [{ on: onHandlers }],
        value,
      };
    },
  } as unknown as DurableMachine["machine"];
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("getAvailableEvents", () => {
  it("returns user-facing events sorted, excluding xstate.* internals", () => {
    const machine = createMockMachine({ pending: ["PAY", "CANCEL"] });
    const snapshot: DurableStateSnapshot = { value: "pending", context: {}, status: "running" };

    const events = getAvailableEvents(machine, snapshot);

    expect(events).toEqual(["CANCEL", "PAY"]);
  });

  it("returns empty array for final states with no handlers", () => {
    const machine = createMockMachine({ done: [] });
    const snapshot: DurableStateSnapshot = { value: "done", context: {}, status: "done" };

    const events = getAvailableEvents(machine, snapshot);

    expect(events).toEqual([]);
  });

  it("deduplicates events from multiple active nodes", () => {
    const machine = {
      resolveState({ value }: { value: unknown }) {
        return {
          _nodes: [
            { on: { PAY: {}, CANCEL: {} } },
            { on: { PAY: {}, REFUND: {} } },
          ],
          value,
        };
      },
    } as unknown as DurableMachine["machine"];

    const snapshot: DurableStateSnapshot = { value: "pending", context: {}, status: "running" };
    const events = getAvailableEvents(machine, snapshot);

    expect(events).toEqual(["CANCEL", "PAY", "REFUND"]);
  });
});

describe("buildLinks", () => {
  it("builds correct HATEOAS links", () => {
    const links = buildLinks({ basePath: "/api/v1", machineId: "order", instanceId: "ord-123" }, ["PAY", "CANCEL"]);

    expect(links).toEqual({
      self: "/api/v1/machines/order/instances/ord-123",
      send: "/api/v1/machines/order/instances/ord-123/events",
      events: ["PAY", "CANCEL"],
      result: "/api/v1/machines/order/instances/ord-123/result",
      steps: "/api/v1/machines/order/instances/ord-123/steps",
      cancel: "/api/v1/machines/order/instances/ord-123",
      effects: "/api/v1/machines/order/instances/ord-123/effects",
    });
  });

  it("works with empty basePath", () => {
    const links = buildLinks({ basePath: "", machineId: "order", instanceId: "ord-1" }, []);

    expect(links.self).toBe("/machines/order/instances/ord-1");
  });
});

describe("toStateResponse", () => {
  it("assembles a full StateResponse with HATEOAS links", () => {
    const machine = createMockMachine({ pending: ["PAY"] });
    const durable = { machine } as unknown as DurableMachine;
    const snapshot: DurableStateSnapshot = {
      value: "pending",
      context: { orderId: "123" },
      status: "running",
    };

    const response = toStateResponse(durable, { basePath: "", machineId: "order", instanceId: "ord-1" }, snapshot);

    expect(response.instanceId).toBe("ord-1");
    expect(response.state).toBe("pending");
    expect(response.context).toEqual({ orderId: "123" });
    expect(response.status).toBe("running");
    expect(response.links.events).toEqual(["PAY"]);
    expect(response.links.self).toBe("/machines/order/instances/ord-1");
  });
});
