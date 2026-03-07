import { describe, it, expect } from "vitest";
import { createMachine, initialTransition, transition } from "xstate";
import { durableState } from "../../src/durable-state.js";
import { collectAndResolveEffects } from "../../src/effect-collector.js";

describe("collectAndResolveEffects()", () => {
  const machine = createMachine({
    id: "test",
    initial: "idle",
    context: { orderId: "o-123", total: 50 },
    states: {
      idle: {
        ...durableState({
          effects: [
            { type: "webhook", url: "https://example.com/start" },
          ],
        }),
        on: { GO: "processing" },
      },
      processing: {
        ...durableState({
          effects: [
            { type: "analytics", event: "entered_processing", orderId: "{{ context.orderId }}" },
          ],
        }),
        on: { DONE: "finished" },
      },
      finished: {
        ...durableState(),
        on: { RESET: "idle" },
      },
    },
  });

  it("collects effects from entered state nodes after transition", () => {
    const [snapshot] = initialTransition(machine);
    const [next] = transition(machine, snapshot, { type: "GO" });

    const { effects } = collectAndResolveEffects(machine, snapshot, next, { type: "GO" });
    expect(effects).toHaveLength(1);
    expect(effects[0].type).toBe("analytics");
    expect(effects[0].event).toBe("entered_processing");
  });

  it("does not collect when remaining in the same state", () => {
    const [snapshot] = initialTransition(machine);
    // Send an event that doesn't cause a transition
    const [same] = transition(machine, snapshot, { type: "UNKNOWN" as any });

    const { effects } = collectAndResolveEffects(machine, snapshot, same, { type: "UNKNOWN" });
    expect(effects).toHaveLength(0);
  });

  it("resolves {{ context.field }} templates against nextSnapshot.context", () => {
    const [snapshot] = initialTransition(machine);
    const [next] = transition(machine, snapshot, { type: "GO" });

    const { effects } = collectAndResolveEffects(machine, snapshot, next, { type: "GO" });
    expect(effects[0].orderId).toBe("o-123");
  });

  it("resolves {{ event.field }} templates against the event", () => {
    const m = createMachine({
      id: "evtTest",
      initial: "a",
      states: {
        a: {
          ...durableState(),
          on: { NEXT: "b" },
        },
        b: {
          ...durableState({
            effects: [
              { type: "log", message: "Got {{ event.type }}" },
            ],
          }),
          on: { DONE: "c" },
        },
        c: { type: "final" },
      },
    });

    const [s0] = initialTransition(m);
    const [s1] = transition(m, s0, { type: "NEXT" });

    const { effects } = collectAndResolveEffects(m, s0, s1, { type: "NEXT" });
    expect(effects).toHaveLength(1);
    expect(effects[0].message).toBe("Got NEXT");
  });

  it("returns empty array when no effects declared", () => {
    const [snapshot] = initialTransition(machine);
    const [s1] = transition(machine, snapshot, { type: "GO" });
    const [s2] = transition(machine, s1, { type: "DONE" });

    const { effects } = collectAndResolveEffects(machine, s1, s2, { type: "DONE" });
    expect(effects).toHaveLength(0);
  });

  it("does not collect effects from exited nodes (entry-only)", () => {
    // idle has effects; transition FROM idle should NOT fire idle's effects again
    const [snapshot] = initialTransition(machine);
    const [next] = transition(machine, snapshot, { type: "GO" });

    const { effects } = collectAndResolveEffects(machine, snapshot, next, { type: "GO" });
    // Only processing effects, not idle effects
    expect(effects.every((e) => e.type !== "webhook")).toBe(true);
  });
});
