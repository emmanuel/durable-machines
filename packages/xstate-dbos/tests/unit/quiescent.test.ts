import { describe, it, expect } from "vitest";
import { setup, fromPromise, createMachine, initialTransition, transition } from "xstate";
import { quiescent, isQuiescent } from "../../src/quiescent.js";

describe("quiescent()", () => {
  it("returns meta with quiescent marker", () => {
    const result = quiescent();
    expect(result).toEqual({
      meta: { "xstate-dbos": { quiescent: true } },
    });
  });

  it("can be spread into a state definition", () => {
    const machine = createMachine({
      id: "test",
      initial: "waiting",
      states: {
        waiting: {
          ...quiescent(),
          on: { GO: "done" },
        },
        done: { type: "final" },
      },
    });

    expect(machine.id).toBe("test");
  });
});

describe("isQuiescent()", () => {
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
        ...quiescent(),
        on: { GO: "working" },
      },
      working: {
        invoke: {
          src: "doWork",
          onDone: "afterWork",
        },
      },
      afterWork: {
        ...quiescent(),
        on: { NEXT: "done" },
      },
      done: { type: "final" },
    },
  });

  it("returns true for a quiescent state", () => {
    const [snapshot] = initialTransition(machine);
    expect(snapshot.value).toBe("waiting");
    expect(isQuiescent(machine, snapshot)).toBe(true);
  });

  it("returns false for an invoking state", () => {
    const [snapshot] = initialTransition(machine);
    const [next] = transition(machine, snapshot, { type: "GO" });
    expect(next.value).toBe("working");
    expect(isQuiescent(machine, next)).toBe(false);
  });

  it("returns true for a different quiescent state", () => {
    // Build a simple machine where we can reach the second quiescent state
    const m = createMachine({
      id: "twoQ",
      initial: "first",
      states: {
        first: {
          ...quiescent(),
          on: { NEXT: "second" },
        },
        second: {
          ...quiescent(),
          on: { DONE: "end" },
        },
        end: { type: "final" },
      },
    });

    const [s0] = initialTransition(m);
    expect(isQuiescent(m, s0)).toBe(true);

    const [s1] = transition(m, s0, { type: "NEXT" });
    expect(s1.value).toBe("second");
    expect(isQuiescent(m, s1)).toBe(true);
  });
});
