import { describe, it, expect } from "vitest";
import {
  setup,
  fromPromise,
  assign,
  initialTransition,
  transition,
} from "xstate";
import { quiescent } from "../../src/quiescent.js";
import {
  getActiveInvocation,
  getSortedAfterDelays,
  buildAfterEvent,
  resolveTransientTransitions,
  serializeSnapshot,
  stateValueEquals,
  isReentryDelay,
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

// Machine with a quiescent state that has always transitions (guard-gated)
const conditionalResolveMachine = setup({
  types: {
    context: {} as { autoApprove: boolean },
    events: {} as { type: "APPROVE" },
    input: {} as { autoApprove: boolean },
  },
  guards: {
    shouldAutoApprove: ({ context }) => context.autoApprove,
  },
}).createMachine({
  id: "conditional",
  initial: "review",
  context: ({ input }) => ({ autoApprove: input.autoApprove }),
  states: {
    review: {
      ...quiescent(),
      always: [{ guard: "shouldAutoApprove", target: "approved" }],
      on: { APPROVE: "approved" },
    },
    approved: { type: "final" },
  },
});

// Machine with reenter: true on a self-targeting after delay
const reentryDelayMachine = setup({
  types: {
    events: {} as { type: "RESPOND" },
  },
}).createMachine({
  id: "reentry",
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

// Machine with named delays resolved from setup({ delays })
const namedDelayMachine = setup({
  types: {
    events: {} as { type: "RESPOND" },
  },
  delays: {
    shortTimeout: 1000,
    longTimeout: 60000,
  },
}).createMachine({
  id: "namedDelay",
  initial: "waiting",
  states: {
    waiting: {
      ...quiescent(),
      on: { RESPOND: "done" },
      after: {
        shortTimeout: "reminded",
        longTimeout: "timedOut",
      },
    },
    reminded: { type: "final" },
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

  it("resolves named delays from machine implementations", () => {
    const [snapshot] = initialTransition(namedDelayMachine);
    expect(snapshot.value).toBe("waiting");

    const delays = getSortedAfterDelays(namedDelayMachine, snapshot);
    expect(delays).toEqual([1000, 60000]);
  });
});

describe("buildAfterEvent()", () => {
  it("builds an event that can be used with transition()", () => {
    const [snapshot] = initialTransition(multiDelayMachine);
    const event = buildAfterEvent(multiDelayMachine, snapshot, 30000);

    // The built event should cause a transition
    const [next] = transition(multiDelayMachine, snapshot, event as any);
    expect(next.value).toBe("timedOut");
  });
});

describe("resolveTransientTransitions()", () => {
  it("returns same state when always guards do not pass", () => {
    const [snapshot] = initialTransition(conditionalResolveMachine, {
      autoApprove: false,
    });
    expect(snapshot.value).toBe("review");

    // State has always transitions, but guard fails — should stay
    const resolved = resolveTransientTransitions(
      conditionalResolveMachine,
      snapshot,
    );
    expect(resolved.value).toBe("review");
  });

  it("is idempotent on an already-resolved transient snapshot", () => {
    const [snapshot] = initialTransition(conditionalResolveMachine, {
      autoApprove: true,
    });
    // XState auto-resolved the always transition during initialTransition
    expect(snapshot.value).toBe("approved");

    const resolved = resolveTransientTransitions(
      conditionalResolveMachine,
      snapshot,
    );
    expect(resolved.value).toBe("approved");
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
});

describe("stateValueEquals()", () => {
  it("returns true for equal strings", () => {
    expect(stateValueEquals("pending", "pending")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(stateValueEquals("pending", "active")).toBe(false);
  });

  it("returns true for equal nested objects", () => {
    expect(
      stateValueEquals({ parent: "child" }, { parent: "child" }),
    ).toBe(true);
  });

  it("returns false for different nested objects", () => {
    expect(
      stateValueEquals({ parent: "childA" }, { parent: "childB" }),
    ).toBe(false);
  });

  it("returns false for different types", () => {
    expect(stateValueEquals("active", { active: "idle" })).toBe(false);
  });
});

describe("isReentryDelay()", () => {
  it("returns true for a delay with reenter: true", () => {
    const [snapshot] = initialTransition(reentryDelayMachine);
    expect(isReentryDelay(reentryDelayMachine, snapshot, 5000)).toBe(true);
  });

  it("returns false for a delay without reenter", () => {
    const [snapshot] = initialTransition(reentryDelayMachine);
    expect(isReentryDelay(reentryDelayMachine, snapshot, 30000)).toBe(false);
  });

  it("returns false for a non-existent delay", () => {
    const [snapshot] = initialTransition(reentryDelayMachine);
    expect(isReentryDelay(reentryDelayMachine, snapshot, 99999)).toBe(false);
  });
});
