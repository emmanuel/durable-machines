import { describe, it, expect } from "vitest";
import { setup, fromPromise, createMachine, initialTransition, transition } from "xstate";
import { durableState, isDurableState } from "../../src/durable-state.js";

describe("durableState()", () => {
  it("returns durable meta without options", () => {
    const result = durableState();
    expect(result.meta["xstate-durable"]).toEqual({ durable: true });
  });

  it("includes effects in meta when provided", () => {
    const effects = [{ type: "webhook", url: "https://example.com" }];
    const result = durableState({ effects });
    const meta = result.meta["xstate-durable"];
    expect(meta.durable).toBe(true);
    expect(meta.effects).toEqual(effects);
    expect(meta.compiledEffects).toHaveLength(1);
    expect(typeof meta.compiledEffects[0]).toBe("function");
  });

  it("omits effects key when not provided", () => {
    const result = durableState();
    expect("effects" in result.meta["xstate-durable"]).toBe(false);
  });

  it("omits effects key when options object has no effects", () => {
    const result = durableState({});
    expect("effects" in result.meta["xstate-durable"]).toBe(false);
  });
});

describe("isDurableState()", () => {
  const machine = setup({
    types: {
      events: {} as { type: "GO" } | { type: "NEXT" },
    },
    actors: {
      doWork: fromPromise(async () => "result"),
    },
  }).createMachine({
    id: "test",
    initial: "waiting",
    states: {
      waiting: {
        ...durableState(),
        on: { GO: "working" },
      },
      working: {
        invoke: {
          src: "doWork",
          onDone: "afterWork",
        },
      },
      afterWork: {
        ...durableState(),
        on: { NEXT: "done" },
      },
      done: { type: "final" },
    },
  });

  it("returns true for a durable state", () => {
    const [snapshot] = initialTransition(machine);
    expect(snapshot.value).toBe("waiting");
    expect(isDurableState(machine, snapshot)).toBe(true);
  });

  it("returns false for an invoking state", () => {
    const [snapshot] = initialTransition(machine);
    const [next] = transition(machine, snapshot, { type: "GO" });
    expect(next.value).toBe("working");
    expect(isDurableState(machine, next)).toBe(false);
  });

  it("returns true for a different durable state", () => {
    // Build a simple machine where we can reach the second durable state
    const m = createMachine({
      id: "twoD",
      initial: "first",
      states: {
        first: {
          ...durableState(),
          on: { NEXT: "second" },
        },
        second: {
          ...durableState(),
          on: { DONE: "end" },
        },
        end: { type: "final" },
      },
    });

    const [s0] = initialTransition(m);
    expect(isDurableState(m, s0)).toBe(true);

    const [s1] = transition(m, s0, { type: "NEXT" });
    expect(s1.value).toBe("second");
    expect(isDurableState(m, s1)).toBe(true);
  });
});
