import { describe, it, expect } from "vitest";
import { extractGraphData } from "../../../src/dashboard/graph.js";
import type { SerializedMachine } from "@durable-xstate/durable-machine";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A linear machine: idle → processing → done */
function linearMachine(): SerializedMachine {
  return {
    id: "order",
    initial: "idle",
    states: {
      idle: {
        path: "idle",
        type: "atomic",
        durable: true,
        on: { START: [{ target: "processing" }] },
      },
      processing: {
        path: "processing",
        type: "atomic",
        invoke: [{ id: "fetchData", src: "fetchData" }],
        on: {
          "xstate.done.actor.fetchData": [{ target: "done" }],
          "xstate.error.actor.fetchData": [{ target: "error" }],
        },
      },
      done: { path: "done", type: "final" },
      error: { path: "error", type: "final" },
    },
  };
}

/** A compound machine with nested states and various transition types */
function compoundMachine(): SerializedMachine {
  return {
    id: "workflow",
    initial: "active",
    states: {
      active: {
        path: "active",
        type: "compound",
        children: ["active.step1", "active.step2"],
      },
      "active.step1": {
        path: "active.step1",
        type: "atomic",
        durable: true,
        prompt: { type: "confirm", text: "Continue?", confirmEvent: "YES", cancelEvent: "NO" },
        on: { YES: [{ target: "active.step2" }] },
        always: [{ target: "active.step2", guard: "isAutoApproved" }],
      },
      "active.step2": {
        path: "active.step2",
        type: "atomic",
        effects: [{ type: "sendEmail" }],
        after: [{ delay: 5000, target: "timeout" }],
        on: { COMPLETE: [{ target: "done" }] },
      },
      timeout: { path: "timeout", type: "final" },
      done: { path: "done", type: "final" },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("extractGraphData", () => {
  it("produces one node per state and preserves metadata flags", () => {
    const { nodes } = extractGraphData(linearMachine());
    expect(nodes).toHaveLength(4);

    const idle = nodes.find((n) => n.id === "idle")!;
    expect(idle.durable).toBe(true);
    expect(idle.hasInvoke).toBe(false);
    expect(idle.parent).toBeNull();

    const processing = nodes.find((n) => n.id === "processing")!;
    expect(processing.durable).toBe(false);
    expect(processing.hasInvoke).toBe(true);

    const done = nodes.find((n) => n.id === "done")!;
    expect(done.type).toBe("final");
  });

  it("extracts event edges with correct types", () => {
    const { edges } = extractGraphData(linearMachine());

    const startEdge = edges.find((e) => e.label === "START");
    expect(startEdge).toMatchObject({
      source: "idle",
      target: "processing",
      type: "event",
    });

    const doneEdge = edges.find((e) => e.label.includes("xstate.done"));
    expect(doneEdge).toMatchObject({
      source: "processing",
      target: "done",
      type: "done",
    });

    const errorEdge = edges.find((e) => e.label.includes("xstate.error"));
    expect(errorEdge).toMatchObject({
      source: "processing",
      target: "error",
      type: "error",
    });
  });

  it("extracts always edges with guard labels", () => {
    const { edges } = extractGraphData(compoundMachine());

    const alwaysEdge = edges.find((e) => e.type === "always");
    expect(alwaysEdge).toMatchObject({
      source: "active.step1",
      target: "active.step2",
      label: "[isAutoApproved]",
    });
  });

  it("extracts after edges with delay labels", () => {
    const { edges } = extractGraphData(compoundMachine());

    const afterEdge = edges.find((e) => e.type === "after");
    expect(afterEdge).toMatchObject({
      source: "active.step2",
      target: "timeout",
      label: "after 5000ms",
    });
  });

  it("skips transitions with no target (self-transitions without explicit target)", () => {
    const machine: SerializedMachine = {
      id: "test",
      initial: "a",
      states: {
        a: {
          path: "a",
          type: "atomic",
          on: {
            TICK: [{}],              // no target — should be skipped
            GO: [{ target: "b" }],   // has target — should be included
          },
        },
        b: { path: "b", type: "final" },
      },
    };

    const { edges } = extractGraphData(machine);
    expect(edges).toHaveLength(1);
    expect(edges[0].label).toBe("GO");
  });

  it("resolves parent/child relationships from dot-paths", () => {
    const { nodes } = extractGraphData(compoundMachine());

    const step1 = nodes.find((n) => n.id === "active.step1")!;
    expect(step1.parent).toBe("active");
    expect(step1.label).toBe("step1"); // label is leaf segment only

    const active = nodes.find((n) => n.id === "active")!;
    expect(active.parent).toBeNull();
    expect(active.children).toEqual(["active.step1", "active.step2"]);
  });

  it("detects prompt and effects metadata", () => {
    const { nodes } = extractGraphData(compoundMachine());

    const step1 = nodes.find((n) => n.id === "active.step1")!;
    expect(step1.hasPrompt).toBe(true);
    expect(step1.hasEffects).toBe(false);

    const step2 = nodes.find((n) => n.id === "active.step2")!;
    expect(step2.hasPrompt).toBe(false);
    expect(step2.hasEffects).toBe(true);
  });

  it("sets initial from definition", () => {
    const { initial } = extractGraphData(linearMachine());
    expect(initial).toBe("idle");
  });
});
