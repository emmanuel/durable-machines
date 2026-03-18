import { describe, it, expect } from "vitest";
import { fromPromise } from "xstate";
import { validateDefinition } from "../../../src/definition/validate-definition.js";
import { createImplementationRegistry } from "../../../src/definition/registry.js";
import type { MachineDefinition } from "../../../src/definition/types.js";

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

function validDefinition(): MachineDefinition {
  return {
    id: "order",
    initial: "pending",
    context: { orderId: "", total: 0 },
    states: {
      pending: {
        durable: true,
        on: { PAY: { target: "processing" }, CANCEL: { target: "cancelled" } },
      },
      processing: {
        invoke: {
          src: "processPayment",
          input: { total: { $ref: "context.total" } },
          onDone: "paid",
          onError: "failed",
        },
      },
      paid: { type: "final" },
      cancelled: { type: "final" },
      failed: { type: "final" },
    },
  };
}

describe("validateDefinition", () => {
  it("returns valid for a correct definition", () => {
    const result = validateDefinition(validDefinition(), registry);
    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it("reports missing actor src in registry", () => {
    const def = validDefinition();
    def.states.processing.invoke = {
      src: "nonExistentActor",
      onDone: "paid",
      onError: "failed",
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("nonExistentActor"),
    );
  });

  it("reports missing guard type in registry", () => {
    const def = validDefinition();
    def.states.pending.on = {
      PAY: { target: "processing", guard: "nonExistentGuard" },
      CANCEL: { target: "cancelled" },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("nonExistentGuard"),
    );
  });

  it("reports missing action type in registry", () => {
    const def = validDefinition();
    def.states.pending.on = {
      PAY: { target: "processing", actions: "nonExistentAction" },
      CANCEL: { target: "cancelled" },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("nonExistentAction"),
    );
  });

  it("reports missing delay name in registry", () => {
    const def = validDefinition();
    def.states.pending.after = {
      nonExistentDelay: { target: "cancelled" },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("nonExistentDelay"),
    );
  });

  it("reports initial state that doesn't exist", () => {
    const def = validDefinition();
    def.initial = "nonExistent";
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("nonExistent"),
    );
  });

  it("reports transition target that doesn't exist", () => {
    const def = validDefinition();
    def.states.pending.on = {
      PAY: { target: "nonExistentState" },
      CANCEL: { target: "cancelled" },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("nonExistentState"),
    );
  });

  it("reports non-final atomic state with no durable/invoke/always", () => {
    const def = validDefinition();
    def.states.pending = {
      on: { PAY: { target: "processing" } },
      // missing durable: true
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("not durable"),
    );
  });

  it("reports state with both invoke and durable", () => {
    const def = validDefinition();
    def.states.processing = {
      durable: true,
      invoke: {
        src: "processPayment",
        onDone: "paid",
        onError: "failed",
      },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("both invoke and durable"),
    );
  });

  it("reports prompt event types not in on handlers", () => {
    const def = validDefinition();
    def.states.pending = {
      durable: true,
      prompt: {
        type: "confirm",
        text: "Approve?",
        confirmEvent: "APPROVE",
        cancelEvent: "CANCEL_OP",
      },
      on: {
        APPROVE: { target: "processing" },
        // missing CANCEL_OP handler
      },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("CANCEL_OP"),
    );
  });

  it("reports registryId mismatch", () => {
    const def = validDefinition();
    def.registryId = "wrong-id";
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("wrong-id"),
    );
  });

  it("reports $ref with invalid prefix", () => {
    const def = validDefinition();
    def.states.processing.invoke = {
      src: "processPayment",
      input: { total: { $ref: "invalid.total" } },
      onDone: "paid",
      onError: "failed",
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("invalid prefix"),
    );
  });

  it("reports unbalanced {{ }} in template", () => {
    const def = validDefinition();
    def.states.processing.invoke = {
      src: "processPayment",
      input: { label: "{{ context.x" },
      onDone: "paid",
      onError: "failed",
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("unbalanced"),
    );
  });

  it("reports compound state with missing initial", () => {
    const def: MachineDefinition = {
      id: "nested",
      initial: "parent",
      states: {
        parent: {
          // compound (has states) but missing initial
          states: {
            child: { durable: true, on: { GO: { target: "done" } } },
          },
        },
        done: { type: "final" },
      },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("initial"),
    );
  });

  it("accepts valid nested compound states", () => {
    const def: MachineDefinition = {
      id: "nested",
      initial: "parent",
      states: {
        parent: {
          initial: "child",
          states: {
            child: { durable: true, on: { GO: { target: "done" } } },
            done: { type: "final" },
          },
        },
      },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(true);
  });

  it("accepts registryId that matches", () => {
    const def = validDefinition();
    def.registryId = "test-v1";
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(true);
  });

  it("validates guard with params object", () => {
    const def = validDefinition();
    def.states.pending.on = {
      PAY: { target: "processing", guard: { type: "isHighValue", params: { threshold: 100 } } },
      CANCEL: { target: "cancelled" },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(true);
  });

  it("accepts numeric delay strings", () => {
    const def = validDefinition();
    def.states.pending.after = {
      "1000": { target: "cancelled" },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(true);
  });

  it("accepts named delays from registry", () => {
    const def = validDefinition();
    def.states.pending.after = {
      shortTimeout: { target: "cancelled" },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(true);
  });

  it("accepts durable state with effects", () => {
    const def = validDefinition();
    def.states.pending.effects = [
      { type: "webhook", url: "https://example.com" },
    ];
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(true);
  });

  it("reports effects on transient (always-only) state", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "transient",
      states: {
        transient: {
          always: { target: "done" },
          effects: [{ type: "webhook" }],
        },
        done: { type: "final" },
      },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("transient"),
    );
  });

  it("reports unbalanced templates in effect values", () => {
    const def = validDefinition();
    def.states.pending.effects = [
      { type: "webhook", url: "{{ context.url" },
    ];
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("unbalanced"),
    );
  });

  it("reports effects without type field", () => {
    const def = validDefinition();
    def.states.pending.effects = [
      { url: "https://example.com" } as any,
    ];
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("without a \"type\""),
    );
  });
});

describe("expr guard/action definitions", () => {
  const emptyRegistry = createImplementationRegistry({ id: "test" });

  it("accepts guard name in definition.guards", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "a",
      guards: { myGuard: { eq: [1, 1] } },
      states: {
        a: { durable: true, on: { GO: { target: "b", guard: "myGuard" } } },
        b: { type: "final" },
      },
    };
    const result = validateDefinition(def, emptyRegistry);
    expect(result.valid).toBe(true);
  });

  it("accepts action name in definition.actions", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "a",
      actions: { myAction: { type: "assign", transforms: [{ path: ["x"], set: 1 }] } },
      states: {
        a: { durable: true, on: { GO: { target: "b", actions: "myAction" } } },
        b: { type: "final" },
      },
    };
    const result = validateDefinition(def, emptyRegistry);
    expect(result.valid).toBe(true);
  });

  it("accepts guard name in registry (existing behavior)", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "a",
      states: {
        a: { durable: true, on: { GO: { target: "b", guard: "isHighValue" } } },
        b: { type: "final" },
      },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(true);
  });

  it("rejects guard name in both registry and definition (ambiguous)", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "a",
      guards: { isHighValue: { eq: [1, 1] } },
      states: {
        a: { durable: true, on: { GO: { target: "b", guard: "isHighValue" } } },
        b: { type: "final" },
      },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("ambiguous");
  });

  it("rejects action name in both registry and definition (ambiguous)", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "a",
      actions: { notifyUser: { type: "assign", transforms: [] } },
      states: {
        a: { durable: true, on: { GO: { target: "b", actions: "notifyUser" } } },
        b: { type: "final" },
      },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("ambiguous");
  });

  it("rejects guard name in neither registry nor definition", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "a",
      states: {
        a: { durable: true, on: { GO: { target: "b", guard: "missing" } } },
        b: { type: "final" },
      },
    };
    const result = validateDefinition(def, emptyRegistry);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("missing");
  });

  it("rejects action name in neither registry nor definition", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "a",
      states: {
        a: { durable: true, on: { GO: { target: "b", actions: "missing" } } },
        b: { type: "final" },
      },
    };
    const result = validateDefinition(def, emptyRegistry);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("missing");
  });
});

describe("expr invoke input validation", () => {
  it("accepts expr select operator as invoke input", () => {
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
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(true);
  });

  it("accepts expr object operator as invoke input", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "processing",
      states: {
        processing: {
          invoke: {
            src: "processPayment",
            input: { object: { total: { select: ["context", "total"] } } },
            onDone: "done",
            onError: "done",
          },
        },
        done: { type: "final" },
      },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(true);
  });

  it("accepts expr fn operator as invoke input", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "processing",
      states: {
        processing: {
          invoke: {
            src: "processPayment",
            input: { fn: ["str", "hello"] },
            onDone: "done",
            onError: "done",
          },
        },
        done: { type: "final" },
      },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(true);
  });

  it("still reports $ref with invalid prefix", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "processing",
      states: {
        processing: {
          invoke: {
            src: "processPayment",
            input: { $ref: "invalid.total" },
            onDone: "done",
            onError: "done",
          },
        },
        done: { type: "final" },
      },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("invalid prefix"),
    );
  });

  it("still reports unbalanced {{ }} in template", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "processing",
      states: {
        processing: {
          invoke: {
            src: "processPayment",
            input: { label: "{{ context.x" },
            onDone: "done",
            onError: "done",
          },
        },
        done: { type: "final" },
      },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("unbalanced"),
    );
  });
});
