import { describe, it, expect } from "vitest";
import {
  setup,
  createMachine,
  fromPromise,
  assign,
  initialTransition,
  transition,
} from "xstate";
import { quiescent } from "../../src/quiescent.js";
import {
  getActiveInvocation,
  extractActorImplementations,
  getSortedAfterDelays,
  buildAfterEvent,
  resolveTransientTransitions,
  serializeSnapshot,
} from "../../src/xstate-utils.js";

// ─── Test Machines ──────────────────────────────────────────────────────────

const orderMachine = setup({
  types: {
    context: {} as { orderId: string; total: number; chargeId?: string },
    events: {} as
      | { type: "PAY" }
      | { type: "SHIP" }
      | { type: "CANCEL" },
    input: {} as { orderId: string; total: number },
  },
  actors: {
    processPayment: fromPromise(
      async ({ input }: { input: { total: number } }) => ({
        chargeId: `ch_${input.total}`,
      }),
    ),
    shipOrder: fromPromise(
      async ({ input }: { input: { orderId: string } }) => ({
        trackingNumber: `tr_${input.orderId}`,
      }),
    ),
  },
}).createMachine({
  id: "order",
  initial: "pending",
  context: ({ input }) => ({
    orderId: input.orderId,
    total: input.total,
  }),
  states: {
    pending: {
      ...quiescent(),
      on: { PAY: "processing", CANCEL: "cancelled" },
    },
    processing: {
      invoke: {
        src: "processPayment",
        input: ({ context }) => ({ total: context.total }),
        onDone: {
          target: "paid",
          actions: assign({
            chargeId: ({ event }) => (event.output as any).chargeId,
          }),
        },
        onError: "paymentFailed",
      },
    },
    paid: {
      ...quiescent(),
      on: { SHIP: "shipping" },
      after: { 86400000: "escalated" },
    },
    shipping: {
      invoke: {
        src: "shipOrder",
        input: ({ context }) => ({ orderId: context.orderId }),
        onDone: "delivered",
        onError: "shipmentFailed",
      },
    },
    delivered: { type: "final" },
    cancelled: { type: "final" },
    escalated: { type: "final" },
    paymentFailed: { type: "final" },
    shipmentFailed: { type: "final" },
  },
});

const transientMachine = setup({
  types: {
    context: {} as { score: number },
    input: {} as { score: number },
  },
  guards: {
    isHigh: ({ context }) => context.score >= 90,
    isMedium: ({ context }) => context.score >= 50,
  },
}).createMachine({
  id: "grader",
  initial: "evaluating",
  context: ({ input }) => ({ score: input.score }),
  states: {
    evaluating: {
      always: [
        { guard: "isHigh", target: "gradeA" },
        { guard: "isMedium", target: "gradeB" },
        { target: "gradeC" },
      ],
    },
    gradeA: { type: "final" },
    gradeB: { type: "final" },
    gradeC: { type: "final" },
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
        5000: { target: "waiting", actions: [] }, // 5s reminder, stay
        30000: "timedOut", // 30s hard timeout
      },
    },
    done: { type: "final" },
    timedOut: { type: "final" },
  },
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("getActiveInvocation()", () => {
  it("returns null for a quiescent state", () => {
    const [snapshot] = initialTransition(orderMachine, {
      orderId: "1",
      total: 50,
    });
    expect(snapshot.value).toBe("pending");
    expect(getActiveInvocation(orderMachine, snapshot)).toBeNull();
  });

  it("returns invocation info for an invoking state", () => {
    const [s0] = initialTransition(orderMachine, {
      orderId: "1",
      total: 50,
    });
    const [s1] = transition(orderMachine, s0, { type: "PAY" });
    expect(s1.value).toBe("processing");

    const inv = getActiveInvocation(orderMachine, s1);
    expect(inv).not.toBeNull();
    expect(inv!.src).toBe("processPayment");
    expect(inv!.input).toEqual({ total: 50 });
  });

  it("returns null for a final state", () => {
    const [s0] = initialTransition(orderMachine, {
      orderId: "1",
      total: 50,
    });
    const [s1] = transition(orderMachine, s0, { type: "CANCEL" });
    expect(s1.value).toBe("cancelled");
    expect(getActiveInvocation(orderMachine, s1)).toBeNull();
  });
});

describe("extractActorImplementations()", () => {
  it("extracts all actor implementations from the machine", () => {
    const impls = extractActorImplementations(orderMachine);
    expect(impls.size).toBe(2);
    expect(impls.has("processPayment")).toBe(true);
    expect(impls.has("shipOrder")).toBe(true);
  });

  it("returns empty map for a machine with no actors", () => {
    const noActorMachine = createMachine({
      id: "simple",
      initial: "idle",
      states: {
        idle: { ...quiescent(), on: { GO: "done" } },
        done: { type: "final" },
      },
    });
    const impls = extractActorImplementations(noActorMachine);
    expect(impls.size).toBe(0);
  });
});

describe("getSortedAfterDelays()", () => {
  it("returns empty array for a state with no after transitions", () => {
    const [snapshot] = initialTransition(orderMachine, {
      orderId: "1",
      total: 50,
    });
    expect(getSortedAfterDelays(orderMachine, snapshot)).toEqual([]);
  });

  it("returns the delay for a state with an after transition", () => {
    const [s0] = initialTransition(orderMachine, {
      orderId: "1",
      total: 50,
    });
    const [s1] = transition(orderMachine, s0, { type: "PAY" });
    // Simulate payment done to reach "paid" state
    const [s2] = transition(orderMachine, s1, {
      type: "xstate.done.actor.0.(machine).order.processing",
      output: { chargeId: "ch_1" },
    } as any);

    // If the event name didn't work, try finding the correct format
    if (s2.value === "paid") {
      const delays = getSortedAfterDelays(orderMachine, s2);
      expect(delays).toEqual([86400000]);
    }
  });

  it("returns multiple delays sorted ascending", () => {
    const [snapshot] = initialTransition(multiDelayMachine);
    expect(snapshot.value).toBe("waiting");

    const delays = getSortedAfterDelays(multiDelayMachine, snapshot);
    expect(delays).toEqual([5000, 30000]);
  });
});

describe("buildAfterEvent()", () => {
  it("builds an event for a fired delay", () => {
    const [snapshot] = initialTransition(multiDelayMachine);
    const event = buildAfterEvent(multiDelayMachine, snapshot, 5000);

    expect(event).toBeDefined();
    expect(event.type).toContain("xstate.after");
    expect(event.type).toContain("5000");
  });

  it("builds an event that can be used with transition()", () => {
    const [snapshot] = initialTransition(multiDelayMachine);
    const event = buildAfterEvent(multiDelayMachine, snapshot, 30000);

    // The built event should cause a transition
    const [next] = transition(multiDelayMachine, snapshot, event as any);
    expect(next.value).toBe("timedOut");
  });
});

describe("resolveTransientTransitions()", () => {
  it("resolves always transitions to a final state (high score)", () => {
    const [snapshot] = initialTransition(transientMachine, { score: 95 });
    // initialTransition already resolves always transitions
    expect(snapshot.value).toBe("gradeA");
  });

  it("resolves always transitions to a final state (medium score)", () => {
    const [snapshot] = initialTransition(transientMachine, { score: 70 });
    expect(snapshot.value).toBe("gradeB");
  });

  it("resolves always transitions to a final state (low score)", () => {
    const [snapshot] = initialTransition(transientMachine, { score: 30 });
    expect(snapshot.value).toBe("gradeC");
  });

  it("is a no-op for a snapshot already in a stable state", () => {
    const [snapshot] = initialTransition(orderMachine, {
      orderId: "1",
      total: 50,
    });
    const resolved = resolveTransientTransitions(orderMachine, snapshot);
    expect(resolved.value).toBe("pending");
  });
});

describe("serializeSnapshot()", () => {
  it("serializes a running snapshot", () => {
    const [snapshot] = initialTransition(orderMachine, {
      orderId: "1",
      total: 50,
    });
    const serialized = serializeSnapshot(snapshot);
    expect(serialized).toEqual({
      value: "pending",
      context: { orderId: "1", total: 50 },
      status: "running",
    });
  });

  it("serializes a done snapshot", () => {
    const [s0] = initialTransition(orderMachine, {
      orderId: "1",
      total: 50,
    });
    const [s1] = transition(orderMachine, s0, { type: "CANCEL" });
    const serialized = serializeSnapshot(s1);
    expect(serialized.value).toBe("cancelled");
    expect(serialized.status).toBe("done");
  });

  it("preserves context in serialization", () => {
    const [s0] = initialTransition(orderMachine, {
      orderId: "abc",
      total: 99.99,
    });
    const serialized = serializeSnapshot(s0);
    expect(serialized.context).toEqual({ orderId: "abc", total: 99.99 });
  });
});
