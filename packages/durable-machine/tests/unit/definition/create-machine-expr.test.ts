import { describe, it, expect } from "vitest";
import { initialTransition, transition } from "xstate";
import { createMachineFromDefinition } from "../../../src/definition/create-machine.js";
import { createImplementationRegistry } from "../../../src/definition/registry.js";
import type { MachineDefinition } from "../../../src/definition/types.js";
import { createBuiltinRegistry } from "@durable-machines/expr";

describe("createMachineFromDefinition with expr guards/actions", () => {
  const builtins = createBuiltinRegistry({
    uuid: () => "test-uuid",
    now: () => 1000,
  });

  const emptyRegistry = createImplementationRegistry({ id: "test" });

  it("expr guard controls transition", () => {
    const def: MachineDefinition = {
      id: "counter",
      initial: "low",
      context: { count: 0 },
      guards: {
        isHigh: { gt: [{ select: ["context", "count"] }, 5] },
      },
      actions: {
        increment: { type: "assign", transforms: [{ path: ["count"], set: { add: [{ select: ["context", "count"] }, 1] } }] },
      },
      states: {
        low: {
          durable: true,
          on: {
            INC: [
              { target: "high", guard: "isHigh", actions: "increment" },
              { actions: "increment" },
            ],
          },
        },
        high: { type: "final" },
      },
    };

    const machine = createMachineFromDefinition(def, emptyRegistry, { builtins });

    // Initial state
    let [state] = initialTransition(machine);
    expect(state.value).toBe("low");
    expect(state.context.count).toBe(0);

    // Send INC events — should stay in low until count > 5
    for (let i = 0; i < 6; i++) {
      [state] = transition(machine, state, { type: "INC" });
      expect(state.value).toBe("low");
    }
    // count is now 6 — next INC triggers isHigh guard
    [state] = transition(machine, state, { type: "INC" });
    expect(state.value).toBe("high");
    expect(state.context.count).toBe(7);
  });

  it("expr action with params", () => {
    const def: MachineDefinition = {
      id: "paramtest",
      initial: "idle",
      context: { items: { a: 0, b: 0 } },
      actions: {
        setItem: {
          type: "assign",
          transforms: [{ path: ["items", { param: "key" }], set: { param: "value" } }],
        },
      },
      states: {
        idle: {
          durable: true,
          on: {
            SET: { actions: { type: "setItem", params: { key: "a", value: 42 } } },
          },
        },
      },
    };

    const machine = createMachineFromDefinition(def, emptyRegistry, { builtins });
    let [state] = initialTransition(machine);
    [state] = transition(machine, state, { type: "SET" });
    expect(state.context.items.a).toBe(42);
    expect(state.context.items.b).toBe(0);
  });

  it("enqueueActions with emit", () => {
    const def: MachineDefinition = {
      id: "emitter",
      initial: "idle",
      context: { n: 0 },
      actions: {
        incAndEmit: {
          type: "enqueueActions",
          actions: [
            { type: "assign", transforms: [{ path: ["n"], set: { add: [{ select: ["context", "n"] }, 1] } }] },
            { type: "emit", event: { type: "INCREMENTED", n: { add: [{ select: ["context", "n"] }, 1] } } },
          ],
        },
      },
      states: {
        idle: {
          durable: true,
          on: { INC: { actions: "incAndEmit" } },
        },
      },
    };

    const machine = createMachineFromDefinition(def, emptyRegistry, { builtins });
    let [state] = initialTransition(machine);
    [state] = transition(machine, state, { type: "INC" });
    expect(state.context.n).toBe(1);
  });

  it("mixed: expr actions + registry delays coexist", () => {
    const registry = createImplementationRegistry({
      id: "v1",
      delays: { shortDelay: 100 },
    });

    const def: MachineDefinition = {
      id: "mixed",
      initial: "idle",
      context: { x: 0 },
      actions: {
        bump: { type: "assign", transforms: [{ path: ["x"], set: { add: [{ select: ["context", "x"] }, 1] } }] },
      },
      states: {
        idle: {
          durable: true,
          on: { GO: { target: "done", actions: "bump" } },
        },
        done: { type: "final" },
      },
    };

    const machine = createMachineFromDefinition(def, registry, { builtins });
    let [state] = initialTransition(machine);
    [state] = transition(machine, state, { type: "GO" });
    expect(state.value).toBe("done");
    expect(state.context.x).toBe(1);
  });

  it("existing tests still work (no exprOptions)", () => {
    const registry = createImplementationRegistry({
      id: "v1",
      guards: { isPositive: ({ context }: any) => context.n > 0 },
      actions: {},
    });

    const def: MachineDefinition = {
      id: "compat",
      initial: "checking",
      context: { n: 1 },
      states: {
        checking: {
          durable: true,
          on: { CHECK: [
            { target: "yes", guard: "isPositive" },
            { target: "no" },
          ]},
        },
        yes: { type: "final" },
        no: { type: "final" },
      },
    };

    const machine = createMachineFromDefinition(def, registry);
    let [state] = initialTransition(machine);
    [state] = transition(machine, state, { type: "CHECK" });
    expect(state.value).toBe("yes");
  });
});
