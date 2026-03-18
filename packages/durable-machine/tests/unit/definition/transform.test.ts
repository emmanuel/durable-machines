import { describe, it, expect } from "vitest";
import { fromPromise } from "xstate";
import { transformDefinition } from "../../../src/definition/transform.js";
import { createImplementationRegistry } from "../../../src/definition/registry.js";
import type { MachineDefinition } from "../../../src/definition/types.js";
import { defaultBuiltins } from "@durable-machines/expr";

const META_KEY = "xstate-durable";

const registry = createImplementationRegistry({
  id: "test-v1",
  actors: {
    processPayment: fromPromise(async () => ({ chargeId: "ch_1" })),
  },
  guards: {
    isHighValue: () => true,
  },
  actions: {
    notifyUser: () => {},
  },
  delays: {
    shortTimeout: 1000,
  },
});

describe("transformDefinition", () => {
  it("transforms static context into a factory that merges with input", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "idle",
      context: { orderId: "default", total: 0 },
      states: { idle: { type: "final" } },
    };
    const config = transformDefinition(def, registry);

    const factory = config.context as (args: { input?: Record<string, unknown> }) => unknown;
    expect(typeof factory).toBe("function");

    // Without input
    expect(factory({ input: undefined })).toEqual({ orderId: "default", total: 0 });

    // With input overriding
    expect(factory({ input: { orderId: "o1", total: 50 } })).toEqual({
      orderId: "o1",
      total: 50,
    });
  });

  it("transforms durable: true into meta", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "waiting",
      states: {
        waiting: {
          durable: true,
          on: { GO: { target: "done" } },
        },
        done: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;

    expect(states.waiting.meta).toEqual({
      [META_KEY]: { durable: true },
    });
  });

  it("transforms prompt with static text into meta with prompt and durable", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "asking",
      states: {
        asking: {
          prompt: {
            type: "confirm",
            text: "Approve?",
            confirmEvent: "YES",
            cancelEvent: "NO",
          },
          on: { YES: { target: "done" }, NO: { target: "done" } },
        },
        done: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;
    const meta = states.asking.meta[META_KEY];

    expect(meta.durable).toBe(true);
    expect(meta.prompt.type).toBe("confirm");
    expect(meta.prompt.text).toBe("Approve?");
  });

  it("transforms prompt with template text into function", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "asking",
      states: {
        asking: {
          prompt: {
            type: "confirm",
            text: "Ship {{ context.orderId }}?",
            confirmEvent: "YES",
            cancelEvent: "NO",
          },
          on: { YES: { target: "done" }, NO: { target: "done" } },
        },
        done: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry, defaultBuiltins);
    const states = config.states as Record<string, any>;
    const meta = states.asking.meta[META_KEY];

    expect(typeof meta.prompt.text).toBe("function");
    expect(meta.prompt.text({ context: { orderId: "o1" } })).toBe("Ship o1?");
  });

  it("transforms invoke.input with $ref into runtime resolver", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "processing",
      states: {
        processing: {
          invoke: {
            src: "processPayment",
            input: { total: { $ref: "context.total" } },
            onDone: "done",
            onError: "done",
          },
        },
        done: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;
    const inputFn = states.processing.invoke.input;

    expect(typeof inputFn).toBe("function");
    expect(inputFn({ context: { total: 99 } })).toEqual({ total: 99 });
  });

  it("transforms invoke.input with mixed literal and $ref values", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "processing",
      states: {
        processing: {
          invoke: {
            src: "processPayment",
            input: { total: { $ref: "context.total" }, currency: "USD" },
            onDone: "done",
            onError: "done",
          },
        },
        done: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;
    const inputFn = states.processing.invoke.input;

    expect(inputFn({ context: { total: 42 } })).toEqual({
      total: 42,
      currency: "USD",
    });
  });

  it("transforms invoke.input with expr select", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "processing",
      states: {
        processing: {
          invoke: {
            src: "processPayment",
            input: { select: ["context", "total"] },
            onDone: "done",
            onError: "done",
          },
        },
        done: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;
    const inputFn = states.processing.invoke.input;

    expect(typeof inputFn).toBe("function");
    expect(inputFn({ context: { total: 77 } })).toBe(77);
  });

  it("transforms invoke.onDone string shorthand to { target }", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "processing",
      states: {
        processing: {
          invoke: { src: "processPayment", onDone: "paid", onError: "failed" },
        },
        paid: { type: "final" },
        failed: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;

    expect(states.processing.invoke.onDone).toEqual({ target: "paid" });
    expect(states.processing.invoke.onError).toEqual({ target: "failed" });
  });

  it("passes through string guard names", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "start",
      states: {
        start: {
          durable: true,
          on: { GO: { target: "end", guard: "isHighValue" } },
        },
        end: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;

    expect(states.start.on.GO.guard).toBe("isHighValue");
  });

  it("passes through guard objects with params", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "start",
      states: {
        start: {
          durable: true,
          on: {
            GO: {
              target: "end",
              guard: { type: "isHighValue", params: { threshold: 100 } },
            },
          },
        },
        end: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;

    expect(states.start.on.GO.guard).toEqual({
      type: "isHighValue",
      params: { threshold: 100 },
    });
  });

  it("passes through string action names", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "start",
      states: {
        start: {
          durable: true,
          on: { GO: { target: "end", actions: "notifyUser" } },
        },
        end: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;

    expect(states.start.on.GO.actions).toBe("notifyUser");
  });

  it("passes through array of action strings", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "start",
      states: {
        start: {
          durable: true,
          on: { GO: { target: "end", actions: ["notifyUser"] } },
        },
        end: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;

    expect(states.start.on.GO.actions).toEqual(["notifyUser"]);
  });

  it("transforms after with numeric string keys to numeric keys", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "waiting",
      states: {
        waiting: {
          durable: true,
          on: { RESPOND: { target: "done" } },
          after: { "1000": { target: "timedOut" } },
        },
        done: { type: "final" },
        timedOut: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;

    // JS object keys are always strings, but numeric keys sort differently.
    // Verify the key was stored as a number (Object.keys shows it).
    const afterKeys = Object.keys(states.waiting.after);
    expect(afterKeys).toContain("1000");
    expect(states.waiting.after[1000]).toBeDefined();
  });

  it("passes through named delay as string key", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "waiting",
      states: {
        waiting: {
          durable: true,
          on: { RESPOND: { target: "done" } },
          after: { shortTimeout: { target: "timedOut" } },
        },
        done: { type: "final" },
        timedOut: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;

    expect(states.waiting.after.shortTimeout).toBeDefined();
  });

  it("transforms nested compound states recursively", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "parent",
      states: {
        parent: {
          initial: "child",
          states: {
            child: {
              durable: true,
              on: { GO: { target: "childDone" } },
            },
            childDone: { type: "final" },
          },
        },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;

    expect(states.parent.initial).toBe("child");
    expect(states.parent.states.child.meta[META_KEY].durable).toBe(true);
    expect(states.parent.states.childDone.type).toBe("final");
  });

  it("preserves always transitions", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "transient",
      states: {
        transient: {
          always: { target: "done" },
        },
        done: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;

    expect(states.transient.always).toEqual({ target: "done" });
  });

  it("stores raw effects and compiled resolvers in meta", () => {
    const effects = [{ type: "webhook", url: "https://example.com" }];
    const def: MachineDefinition = {
      id: "test",
      initial: "waiting",
      states: {
        waiting: {
          durable: true,
          effects,
          on: { GO: { target: "done" } },
        },
        done: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;
    const meta = states.waiting.meta[META_KEY];

    expect(meta.durable).toBe(true);
    // Raw effects preserved for validation/serialization
    expect(meta.effects).toEqual(effects);
    // Compiled resolvers for runtime
    expect(meta.compiledEffects).toHaveLength(1);
    expect(typeof meta.compiledEffects[0]).toBe("function");
    expect(meta.compiledEffects[0]({ context: {} })).toEqual({ type: "webhook", url: "https://example.com" });
  });

  it("compiles template expressions in effects as resolver functions", () => {
    const effects = [
      { type: "webhook", url: "https://example.com/{{ context.orderId }}" },
    ];
    const def: MachineDefinition = {
      id: "test",
      initial: "waiting",
      states: {
        waiting: {
          durable: true,
          effects,
          on: { GO: { target: "done" } },
        },
        done: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry, defaultBuiltins);
    const states = config.states as Record<string, any>;
    const meta = states.waiting.meta[META_KEY];

    // Raw effects preserved
    expect(meta.effects).toEqual(effects);
    // Compiled resolvers resolve templates
    expect(typeof meta.compiledEffects[0]).toBe("function");
    expect(meta.compiledEffects[0]({ context: { orderId: "o-42" } })).toEqual({
      type: "webhook",
      url: "https://example.com/o-42",
    });
  });

  it("includes effects-only meta without durable flag", () => {
    const effects = [{ type: "log", message: "entered" }];
    const def: MachineDefinition = {
      id: "test",
      initial: "processing",
      states: {
        processing: {
          effects,
          invoke: {
            src: "processPayment",
            onDone: "done",
            onError: "done",
          },
        },
        done: { type: "final" },
      },
    };
    const config = transformDefinition(def, registry);
    const states = config.states as Record<string, any>;
    const meta = states.processing.meta[META_KEY];

    // effects alone don't set durable: true
    expect(meta.durable).toBeUndefined();
    // Raw effects preserved
    expect(meta.effects).toEqual(effects);
    // Compiled resolvers for runtime
    expect(meta.compiledEffects).toHaveLength(1);
    expect(typeof meta.compiledEffects[0]).toBe("function");
    expect(meta.compiledEffects[0]({ context: {} })).toEqual({
      type: "log",
      message: "entered",
    });
  });
});
