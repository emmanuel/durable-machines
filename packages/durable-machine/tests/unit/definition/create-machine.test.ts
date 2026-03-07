import { describe, it, expect } from "vitest";
import { fromPromise, initialTransition, transition } from "xstate";
import { createMachineFromDefinition } from "../../../src/definition/create-machine.js";
import { createImplementationRegistry } from "../../../src/definition/registry.js";
import { validateMachineForDurability } from "../../../src/validate.js";
import { getPromptConfig } from "../../../src/prompt.js";
import { getSortedAfterDelays } from "../../../src/xstate-utils.js";
import { DurableMachineValidationError } from "../../../src/types.js";
import type { MachineDefinition } from "../../../src/definition/types.js";
import { orderMachine } from "../../fixtures/machines.js";

// ─── Shared Registry ────────────────────────────────────────────────────────

const registry = createImplementationRegistry({
  id: "test-v1",
  actors: {
    processPayment: fromPromise(
      async ({ input }: { input: { total: number } }) => {
        return { chargeId: `ch_${input.total}` };
      },
    ),
    shipOrder: fromPromise(
      async ({ input }: { input: { orderId: string } }) => {
        return { trackingNumber: `tr_${input.orderId}` };
      },
    ),
  },
  guards: {
    isHighValue: ({ context }: any) => context.total > 100,
  },
  actions: {},
  delays: {
    shortTimeout: 1000,
  },
});

// ─── Equivalence Test ───────────────────────────────────────────────────────

describe("createMachineFromDefinition — equivalence", () => {
  const definition: MachineDefinition = {
    id: "order",
    initial: "pending",
    context: { orderId: "", total: 0 },
    states: {
      pending: {
        durable: true,
        on: {
          PAY: { target: "processing" },
          CANCEL: { target: "cancelled" },
        },
      },
      processing: {
        invoke: {
          src: "processPayment",
          input: { total: { $ref: "context.total" } },
          onDone: { target: "paid" },
          onError: { target: "paymentFailed" },
        },
      },
      paid: {
        durable: true,
        on: { SHIP: { target: "shipping" } },
      },
      shipping: {
        invoke: {
          src: "shipOrder",
          input: { orderId: { $ref: "context.orderId" } },
          onDone: { target: "delivered" },
          onError: { target: "shipmentFailed" },
        },
      },
      delivered: { type: "final" },
      cancelled: { type: "final" },
      paymentFailed: { type: "final" },
      shipmentFailed: { type: "final" },
    },
  };

  const jsonMachine = createMachineFromDefinition(definition, registry);
  const input = { orderId: "o1", total: 42 };

  it("produces the same initial state value", () => {
    const [jsonInitial] = initialTransition(jsonMachine, input);
    const [tsInitial] = initialTransition(orderMachine, input);

    expect(jsonInitial.value).toEqual(tsInitial.value);
  });

  it("transitions on PAY to the same state", () => {
    const [jsonInitial] = initialTransition(jsonMachine, input);
    const [tsInitial] = initialTransition(orderMachine, input);

    const [jsonAfterPay] = transition(jsonMachine, jsonInitial, { type: "PAY" });
    const [tsAfterPay] = transition(orderMachine, tsInitial, { type: "PAY" });

    expect(jsonAfterPay.value).toEqual(tsAfterPay.value);
  });

  it("transitions CANCEL from pending to cancelled", () => {
    const [jsonInitial] = initialTransition(jsonMachine, input);
    const [tsInitial] = initialTransition(orderMachine, input);

    const [jsonAfterCancel] = transition(jsonMachine, jsonInitial, { type: "CANCEL" });
    const [tsAfterCancel] = transition(orderMachine, tsInitial, { type: "CANCEL" });

    expect(jsonAfterCancel.value).toEqual(tsAfterCancel.value);
    expect(jsonAfterCancel.value).toBe("cancelled");
  });
});

// ─── Validation Integration ─────────────────────────────────────────────────

describe("createMachineFromDefinition — validation", () => {
  it("throws DurableMachineValidationError for invalid definition", () => {
    const invalid: MachineDefinition = {
      id: "bad",
      initial: "start",
      states: {
        start: {
          // not durable, no invoke, no always → invalid
          on: { GO: { target: "end" } },
        },
        end: { type: "final" },
      },
    };

    expect(() => createMachineFromDefinition(invalid, registry)).toThrow(
      DurableMachineValidationError,
    );
  });

  it("throws for missing actor in registry", () => {
    const invalid: MachineDefinition = {
      id: "bad",
      initial: "start",
      states: {
        start: {
          invoke: { src: "missingActor", onDone: "end", onError: "end" },
        },
        end: { type: "final" },
      },
    };

    expect(() => createMachineFromDefinition(invalid, registry)).toThrow(
      DurableMachineValidationError,
    );
  });
});

// ─── Durable Compatibility ──────────────────────────────────────────────────

describe("createMachineFromDefinition — durable compatibility", () => {
  it("created machine passes validateMachineForDurability()", () => {
    const def: MachineDefinition = {
      id: "durable-check",
      initial: "waiting",
      states: {
        waiting: {
          durable: true,
          on: { DONE: { target: "finished" } },
        },
        finished: { type: "final" },
      },
    };

    const machine = createMachineFromDefinition(def, registry);
    expect(() => validateMachineForDurability(machine)).not.toThrow();
  });

  it("invoke states pass durability validation", () => {
    const def: MachineDefinition = {
      id: "invoke-check",
      initial: "processing",
      states: {
        processing: {
          invoke: {
            src: "processPayment",
            input: { total: { $ref: "context.total" } },
            onDone: "done",
            onError: "failed",
          },
        },
        done: { type: "final" },
        failed: { type: "final" },
      },
    };

    const machine = createMachineFromDefinition(def, registry);
    expect(() => validateMachineForDurability(machine)).not.toThrow();
  });
});

// ─── Prompt Machine ─────────────────────────────────────────────────────────

describe("createMachineFromDefinition — prompt", () => {
  it("produces correct prompt metadata accessible via getPromptConfig()", () => {
    const def: MachineDefinition = {
      id: "prompt-check",
      initial: "asking",
      states: {
        asking: {
          durable: true,
          prompt: {
            type: "choice",
            text: "Pick one",
            options: [
              { label: "A", event: "PICK_A" },
              { label: "B", event: "PICK_B" },
            ],
          },
          on: {
            PICK_A: { target: "done" },
            PICK_B: { target: "done" },
          },
        },
        done: { type: "final" },
      },
    };

    const machine = createMachineFromDefinition(def, registry);
    const [snapshot] = initialTransition(machine);
    const stateNode = snapshot._nodes.find(
      (n: any) => n.type === "atomic" && n.key === "asking",
    );
    const promptCfg = getPromptConfig(stateNode?.meta);

    expect(promptCfg).not.toBeNull();
    expect(promptCfg!.type).toBe("choice");
  });

  it("template prompt text resolves correctly at runtime", () => {
    const def: MachineDefinition = {
      id: "prompt-template",
      initial: "asking",
      context: { orderId: "" },
      states: {
        asking: {
          durable: true,
          prompt: {
            type: "confirm",
            text: "Ship {{ context.orderId }}?",
            confirmEvent: "YES",
            cancelEvent: "NO",
          },
          on: {
            YES: { target: "done" },
            NO: { target: "done" },
          },
        },
        done: { type: "final" },
      },
    };

    const machine = createMachineFromDefinition(def, registry);
    const [snapshot] = initialTransition(machine, { orderId: "order-123" });
    const stateNode = snapshot._nodes.find(
      (n: any) => n.type === "atomic" && n.key === "asking",
    );
    const promptCfg = getPromptConfig(stateNode?.meta);

    expect(promptCfg).not.toBeNull();
    expect(typeof promptCfg!.text).toBe("function");
    const text = (promptCfg!.text as Function)({ context: snapshot.context });
    expect(text).toBe("Ship order-123?");
  });
});

// ─── After Delays ───────────────────────────────────────────────────────────

describe("createMachineFromDefinition — after delays", () => {
  it("numeric after delays are accessible via getSortedAfterDelays()", () => {
    const def: MachineDefinition = {
      id: "delay-check",
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

    const machine = createMachineFromDefinition(def, registry);
    const [snapshot] = initialTransition(machine);
    const delays = getSortedAfterDelays(machine, snapshot);

    expect(delays).toEqual([1000]);
  });

  it("named delays work with registry", () => {
    const def: MachineDefinition = {
      id: "named-delay-check",
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

    const machine = createMachineFromDefinition(def, registry);
    const [snapshot] = initialTransition(machine);
    const delays = getSortedAfterDelays(machine, snapshot);

    expect(delays).toEqual([1000]);
  });
});
