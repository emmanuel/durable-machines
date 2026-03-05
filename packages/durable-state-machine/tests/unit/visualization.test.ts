import { describe, it, expect } from "vitest";
import { setup, fromPromise, createMachine } from "xstate";
import { quiescent } from "../../src/quiescent.js";
import { prompt } from "../../src/prompt.js";
import {
  serializeMachineDefinition,
  computeStateDurations,
  detectActiveStep,
} from "../../src/visualization.js";
import type { TransitionRecord, StepInfo } from "../../src/types.js";

// ─── Test Machines ──────────────────────────────────────────────────────────

const simpleMachine = createMachine({
  id: "simple",
  initial: "waiting",
  states: {
    waiting: {
      ...quiescent(),
      on: { GO: "done" },
    },
    done: { type: "final" },
  },
});

const orderMachine = setup({
  types: {
    context: {} as { orderId: string; total: number },
    events: {} as { type: "PAY" } | { type: "SHIP" } | { type: "CANCEL" },
    input: {} as { orderId: string; total: number },
  },
  actors: {
    processPayment: fromPromise(
      async ({ input }: { input: { total: number } }) => ({
        chargeId: `ch_${input.total}`,
      }),
    ),
  },
}).createMachine({
  id: "order",
  initial: "pending",
  context: ({ input }) => ({ orderId: input.orderId, total: input.total }),
  states: {
    pending: {
      ...quiescent(),
      on: { PAY: "processing", CANCEL: "cancelled" },
    },
    processing: {
      invoke: {
        src: "processPayment",
        input: ({ context }) => ({ total: context.total }),
        onDone: "paid",
        onError: "failed",
      },
    },
    paid: {
      ...quiescent(),
      on: { SHIP: "shipped" },
      after: { 86400000: "escalated" },
    },
    shipped: { type: "final" },
    cancelled: { type: "final" },
    escalated: { type: "final" },
    failed: { type: "final" },
  },
});

const promptMachine = createMachine({
  id: "prompted",
  initial: "waiting",
  states: {
    waiting: {
      ...prompt({
        type: "choice",
        text: "Approve?",
        options: [
          { label: "Yes", event: "APPROVE" },
          { label: "No", event: "REJECT" },
        ],
      }),
      on: { APPROVE: "approved", REJECT: "rejected" },
    },
    approved: { type: "final" },
    rejected: { type: "final" },
  },
});

const compoundMachine = createMachine({
  id: "compound",
  initial: "parent",
  states: {
    parent: {
      initial: "childA",
      states: {
        childA: {
          ...quiescent(),
          on: { NEXT: "childB" },
        },
        childB: { type: "final" },
      },
      onDone: "done",
    },
    done: { type: "final" },
  },
});

const alwaysMachine = setup({
  guards: {
    isReady: () => true,
  },
}).createMachine({
  id: "transient",
  initial: "checking",
  states: {
    checking: {
      always: [
        { guard: "isReady", target: "ready" },
        { target: "notReady" },
      ],
    },
    ready: {
      ...quiescent(),
      on: { DONE: "finished" },
    },
    notReady: {
      ...quiescent(),
      on: { RETRY: "checking" },
    },
    finished: { type: "final" },
  },
});

const multiDelayMachine = setup({
  types: {
    events: {} as { type: "RESPOND" },
  },
}).createMachine({
  id: "reminder",
  initial: "waiting",
  states: {
    waiting: {
      ...quiescent(),
      on: { RESPOND: "done" },
      after: {
        5000: { target: "waiting", reenter: true },
        30000: "timedOut",
      },
    },
    done: { type: "final" },
    timedOut: { type: "final" },
  },
});

const parallelMachine = createMachine({
  id: "parallel",
  type: "parallel",
  states: {
    regionA: {
      initial: "idle",
      states: {
        idle: {
          ...quiescent(),
          on: { A: "active" },
        },
        active: { type: "final" },
      },
    },
    regionB: {
      initial: "idle",
      states: {
        idle: {
          ...quiescent(),
          on: { B: "active" },
        },
        active: { type: "final" },
      },
    },
  },
});

// ─── serializeMachineDefinition() ──────────────────────────────────────────

describe("serializeMachineDefinition()", () => {
  it("extracts state nodes with correct paths and types", () => {
    const def = serializeMachineDefinition(simpleMachine);
    expect(def.id).toBe("simple");
    expect(def.initial).toBe("waiting");
    expect(Object.keys(def.states)).toEqual(["waiting", "done"]);
    expect(def.states["waiting"].type).toBe("atomic");
    expect(def.states["done"].type).toBe("final");
  });

  it("marks quiescent states", () => {
    const def = serializeMachineDefinition(orderMachine);
    expect(def.states["pending"].quiescent).toBe(true);
    expect(def.states["paid"].quiescent).toBe(true);
    expect(def.states["processing"].quiescent).toBeUndefined();
    expect(def.states["cancelled"].quiescent).toBeUndefined();
  });

  it("includes prompt config", () => {
    const def = serializeMachineDefinition(promptMachine);
    const waiting = def.states["waiting"];
    expect(waiting.quiescent).toBe(true);
    expect(waiting.prompt).toBeDefined();
    expect(waiting.prompt!.type).toBe("choice");
    expect((waiting.prompt as any).options).toHaveLength(2);
  });

  it("captures invoke definitions", () => {
    const def = serializeMachineDefinition(orderMachine);
    const processing = def.states["processing"];
    expect(processing.invoke).toBeDefined();
    expect(processing.invoke).toHaveLength(1);
    expect(processing.invoke![0].src).toBe("processPayment");
  });

  it("captures after transitions with delay and target", () => {
    const def = serializeMachineDefinition(orderMachine);
    const paid = def.states["paid"];
    expect(paid.after).toBeDefined();
    expect(paid.after).toHaveLength(1);
    expect(paid.after![0].delay).toBe(86400000);
    expect(paid.after![0].target).toBe("escalated");
  });

  it("captures after transitions with reenter flag", () => {
    const def = serializeMachineDefinition(multiDelayMachine);
    const waiting = def.states["waiting"];
    expect(waiting.after).toBeDefined();
    expect(waiting.after!.length).toBeGreaterThanOrEqual(2);

    const reentryDelay = waiting.after!.find((a) => a.delay === 5000);
    expect(reentryDelay).toBeDefined();
    expect(reentryDelay!.reenter).toBe(true);

    const timeoutDelay = waiting.after!.find((a) => a.delay === 30000);
    expect(timeoutDelay).toBeDefined();
    expect(timeoutDelay!.target).toBe("timedOut");
  });

  it("captures always transitions with guards", () => {
    const def = serializeMachineDefinition(alwaysMachine);
    const checking = def.states["checking"];
    expect(checking.always).toBeDefined();
    expect(checking.always!.length).toBeGreaterThanOrEqual(2);
    expect(checking.always![0].guard).toBe("isReady");
    expect(checking.always![0].target).toBe("ready");
  });

  it("captures on event handlers with targets", () => {
    const def = serializeMachineDefinition(orderMachine);
    const pending = def.states["pending"];
    expect(pending.on).toBeDefined();
    expect(pending.on!["PAY"]).toBeDefined();
    expect(pending.on!["PAY"][0].target).toBe("processing");
    expect(pending.on!["CANCEL"]).toBeDefined();
    expect(pending.on!["CANCEL"][0].target).toBe("cancelled");
  });

  it("handles compound states with children", () => {
    const def = serializeMachineDefinition(compoundMachine);
    const parent = def.states["parent"];
    expect(parent.type).toBe("compound");
    expect(parent.children).toEqual(["parent.childA", "parent.childB"]);
    expect(def.states["parent.childA"]).toBeDefined();
    expect(def.states["parent.childA"].type).toBe("atomic");
    expect(def.states["parent.childB"]).toBeDefined();
    expect(def.states["parent.childB"].type).toBe("final");
  });

  it("handles parallel states with children", () => {
    const def = serializeMachineDefinition(parallelMachine);
    expect(def.states["regionA"]).toBeDefined();
    expect(def.states["regionA"].type).toBe("compound");
    expect(def.states["regionB"]).toBeDefined();
    expect(def.states["regionB"].type).toBe("compound");
    expect(def.states["regionA.idle"]).toBeDefined();
    expect(def.states["regionB.active"]).toBeDefined();
  });
});

// ─── computeStateDurations() ─────────────────────────────────────────────

describe("computeStateDurations()", () => {
  it("computes durations for a linear sequence", () => {
    const transitions: TransitionRecord[] = [
      { from: null, to: "pending", ts: 1000 },
      { from: "pending", to: "processing", ts: 2000 },
      { from: "processing", to: "done", ts: 5000 },
    ];
    const durations = computeStateDurations(transitions);
    expect(durations).toHaveLength(3);
    expect(durations[0]).toEqual({
      state: "pending",
      enteredAt: 1000,
      exitedAt: 2000,
      durationMs: 1000,
    });
    expect(durations[1]).toEqual({
      state: "processing",
      enteredAt: 2000,
      exitedAt: 5000,
      durationMs: 3000,
    });
    expect(durations[2].state).toBe("done");
    expect(durations[2].enteredAt).toBe(5000);
    expect(durations[2].exitedAt).toBeNull();
    expect(durations[2].durationMs).toBeGreaterThan(0);
  });

  it("handles currently-active state (exitedAt = null)", () => {
    const transitions: TransitionRecord[] = [
      { from: null, to: "waiting", ts: 1000 },
    ];
    const durations = computeStateDurations(transitions);
    expect(durations).toHaveLength(1);
    expect(durations[0].state).toBe("waiting");
    expect(durations[0].exitedAt).toBeNull();
    expect(durations[0].durationMs).toBeGreaterThan(0);
  });

  it("returns empty array for empty transitions", () => {
    expect(computeStateDurations([])).toEqual([]);
  });
});

// ─── detectActiveStep() ─────────────────────────────────────────────────

describe("detectActiveStep()", () => {
  it("returns the incomplete step", () => {
    const steps: StepInfo[] = [
      {
        name: "invoke:processPayment",
        output: { chargeId: "ch_1" },
        error: null,
        startedAtEpochMs: 1000,
        completedAtEpochMs: 2000,
      },
      {
        name: "invoke:shipOrder",
        output: null,
        error: null,
        startedAtEpochMs: 3000,
      },
    ];
    const active = detectActiveStep(steps);
    expect(active).not.toBeNull();
    expect(active!.name).toBe("invoke:shipOrder");
  });

  it("returns null when all steps are complete", () => {
    const steps: StepInfo[] = [
      {
        name: "invoke:processPayment",
        output: { chargeId: "ch_1" },
        error: null,
        startedAtEpochMs: 1000,
        completedAtEpochMs: 2000,
      },
    ];
    expect(detectActiveStep(steps)).toBeNull();
  });

  it("returns null for empty steps", () => {
    expect(detectActiveStep([])).toBeNull();
  });
});
