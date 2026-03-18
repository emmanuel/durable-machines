import { describe, it, expect } from "vitest";
import { createMachine, initialTransition, transition } from "xstate";
import { durableState } from "../../src/durable-state.js";
import { collectAndResolveEffects, extractEmittedEffects } from "../../src/effect-collector.js";

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

describe("extractEmittedEffects()", () => {
  it("extracts xstate.emit actions as ResolvedEffects", () => {
    const actions = [
      {
        type: "xstate.emit",
        params: {
          event: { type: "EMIT_SATISFIED_AU", auId: "au-1", score: 100 },
        },
      },
      {
        type: "xstate.emit",
        params: {
          event: { type: "EMIT_LOG", message: "hello" },
        },
      },
    ];

    const effects = extractEmittedEffects(actions);
    expect(effects).toHaveLength(2);
    expect(effects[0]).toEqual({ type: "EMIT_SATISFIED_AU", auId: "au-1", score: 100 });
    expect(effects[1]).toEqual({ type: "EMIT_LOG", message: "hello" });
  });

  it("ignores non-emit actions", () => {
    const actions = [
      { type: "xstate.assign", params: { context: {} } },
      { type: "xstate.raise", params: { event: { type: "NEXT" } } },
      {
        type: "xstate.emit",
        params: {
          event: { type: "EMIT_EFFECT", data: "value" },
        },
      },
    ];

    const effects = extractEmittedEffects(actions);
    expect(effects).toHaveLength(1);
    expect(effects[0].type).toBe("EMIT_EFFECT");
  });

  it("returns empty array when no emit actions present", () => {
    const actions = [
      { type: "xstate.assign", params: { context: {} } },
    ];

    const effects = extractEmittedEffects(actions);
    expect(effects).toHaveLength(0);
  });

  it("returns empty array for empty actions array", () => {
    const effects = extractEmittedEffects([]);
    expect(effects).toHaveLength(0);
  });

  it("skips emit actions with missing or invalid event", () => {
    const actions = [
      { type: "xstate.emit", params: {} },
      { type: "xstate.emit", params: { event: { noType: true } } },
      { type: "xstate.emit" },
    ];

    const effects = extractEmittedEffects(actions as any);
    expect(effects).toHaveLength(0);
  });
});
