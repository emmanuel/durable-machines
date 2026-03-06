/**
 * Shared test machine definitions used by conformance tests.
 * Each machine exercises a specific feature of the durable machine runtime.
 */
import { setup, fromPromise, assign } from "xstate";
import { durableState } from "../../src/durable-state.js";
import { prompt } from "../../src/prompt.js";

// ─── Lifecycle ─────────────────────────────────────────────────────────────

export const orderMachine = setup({
  types: {
    context: {} as {
      orderId: string;
      total: number;
      chargeId?: string;
      trackingNumber?: string;
    },
    events: {} as { type: "PAY" } | { type: "SHIP" } | { type: "CANCEL" },
    input: {} as { orderId: string; total: number },
  },
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
}).createMachine({
  id: "order",
  initial: "pending",
  context: ({ input }) => ({ orderId: input.orderId, total: input.total }),
  states: {
    pending: {
      ...durableState(),
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
      ...durableState(),
      on: { SHIP: "shipping" },
    },
    shipping: {
      invoke: {
        src: "shipOrder",
        input: ({ context }) => ({ orderId: context.orderId }),
        onDone: {
          target: "delivered",
          actions: assign({
            trackingNumber: ({ event }) =>
              (event.output as any).trackingNumber,
          }),
        },
        onError: "shipmentFailed",
      },
    },
    delivered: { type: "final" },
    cancelled: { type: "final" },
    paymentFailed: { type: "final" },
    shipmentFailed: { type: "final" },
  },
});

// ─── After Transitions ─────────────────────────────────────────────────────

export const singleDelayMachine = setup({
  types: {
    context: {} as { timedOut: boolean },
    events: {} as { type: "RESPOND" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "singleDelay",
  initial: "waiting",
  context: { timedOut: false },
  states: {
    waiting: {
      ...durableState(),
      on: { RESPOND: "responded" },
      after: {
        1000: {
          target: "timedOut",
          actions: assign({ timedOut: true }),
        },
      },
    },
    responded: { type: "final" },
    timedOut: { type: "final" },
  },
});

export const raceEventMachine = setup({
  types: {
    context: {} as { winner: string },
    events: {} as { type: "RESPOND" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "raceEvent",
  initial: "waiting",
  context: { winner: "none" },
  states: {
    waiting: {
      ...durableState(),
      on: {
        RESPOND: {
          target: "responded",
          actions: assign({ winner: "event" }),
        },
      },
      after: {
        5000: {
          target: "timedOut",
          actions: assign({ winner: "timeout" }),
        },
      },
    },
    responded: { type: "final" },
    timedOut: { type: "final" },
  },
});

export const multiDelayMachine = setup({
  types: {
    context: {} as { reminders: number },
    events: {} as { type: "RESPOND" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "multiDelay",
  initial: "waiting",
  context: { reminders: 0 },
  states: {
    waiting: {
      ...durableState(),
      on: { RESPOND: "responded" },
      after: {
        1000: {
          actions: assign({ reminders: ({ context }) => context.reminders + 1 }),
        },
        3000: "escalated",
      },
    },
    responded: { type: "final" },
    escalated: { type: "final" },
  },
});

export const selfTargetMachine = setup({
  types: {
    context: {} as { ticks: number },
    events: {} as { type: "STOP" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "selfTarget",
  initial: "ticking",
  context: { ticks: 0 },
  states: {
    ticking: {
      ...durableState(),
      on: { STOP: "stopped" },
      after: {
        1000: {
          target: "ticking",
          actions: assign({ ticks: ({ context }) => context.ticks + 1 }),
          reenter: true,
        },
      },
    },
    stopped: { type: "final" },
  },
});

export const namedDelayMachine = setup({
  types: {
    context: {} as { expired: boolean },
    events: {} as { type: "RESPOND" },
    input: {} as Record<string, never>,
  },
  delays: {
    shortTimeout: 1000,
  },
}).createMachine({
  id: "namedDelay",
  initial: "waiting",
  context: { expired: false },
  states: {
    waiting: {
      ...durableState(),
      on: { RESPOND: "responded" },
      after: {
        shortTimeout: {
          target: "timedOut",
          actions: assign({ expired: true }),
        },
      },
    },
    responded: { type: "final" },
    timedOut: { type: "final" },
  },
});

// ─── Prompt & Channels ──────────────────────────────────────────────────────

export const approvalMachine = setup({
  types: {
    context: {} as { decision: string },
    events: {} as { type: "APPROVE" } | { type: "REJECT" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "approval",
  initial: "pending",
  context: { decision: "none" },
  states: {
    pending: {
      ...prompt({
        type: "choice",
        text: "Do you approve this request?",
        options: [
          { label: "Approve", event: "APPROVE", style: "primary" },
          { label: "Reject", event: "REJECT", style: "danger" },
        ],
      }),
      on: {
        APPROVE: {
          target: "approved",
          actions: assign({ decision: "approved" }),
        },
        REJECT: {
          target: "rejected",
          actions: assign({ decision: "rejected" }),
        },
      },
    },
    approved: { type: "final" },
    rejected: { type: "final" },
  },
});

export const multiStepMachine = setup({
  types: {
    context: {} as { step: number },
    events: {} as { type: "NEXT" } | { type: "BACK" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "multiStep",
  initial: "step1",
  context: { step: 1 },
  states: {
    step1: {
      ...prompt({
        type: "choice",
        text: "Ready for step 1?",
        options: [{ label: "Next", event: "NEXT" }],
      }),
      on: {
        NEXT: {
          target: "step2",
          actions: assign({ step: 2 }),
        },
      },
    },
    step2: {
      ...prompt({
        type: "confirm",
        text: "Ready for step 2?",
        confirmEvent: "NEXT",
        cancelEvent: "BACK",
      }),
      on: {
        NEXT: {
          target: "done",
          actions: assign({ step: 3 }),
        },
        BACK: {
          target: "step1",
          actions: assign({ step: 1 }),
        },
      },
    },
    done: { type: "final" },
  },
});

export const dynamicPromptMachine = setup({
  types: {
    context: {} as { name: string; confirmed: boolean },
    events: {} as { type: "CONFIRM" } | { type: "CANCEL" },
    input: {} as { name: string },
  },
}).createMachine({
  id: "dynamicPrompt",
  initial: "confirming",
  context: ({ input }) => ({ name: input.name, confirmed: false }),
  states: {
    confirming: {
      ...prompt({
        type: "confirm",
        text: ({ context }) => `Confirm action for ${context.name}?`,
        confirmEvent: "CONFIRM",
        cancelEvent: "CANCEL",
      }),
      on: {
        CONFIRM: {
          target: "confirmed",
          actions: assign({ confirmed: true }),
        },
        CANCEL: "cancelled",
      },
    },
    confirmed: { type: "final" },
    cancelled: { type: "final" },
  },
});

export const promptWithTimeoutMachine = setup({
  types: {
    context: {} as { timedOut: boolean },
    events: {} as { type: "RESPOND" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "promptTimeout",
  initial: "waiting",
  context: { timedOut: false },
  states: {
    waiting: {
      ...prompt({
        type: "choice",
        text: "Please respond before timeout",
        options: [{ label: "Respond", event: "RESPOND" }],
      }),
      on: { RESPOND: "responded" },
      after: {
        1000: {
          target: "timedOut",
          actions: assign({ timedOut: true }),
        },
      },
    },
    responded: { type: "final" },
    timedOut: { type: "final" },
  },
});

// ─── Visualization ──────────────────────────────────────────────────────────

export function makeVizMachine(id: string) {
  return setup({
    types: {
      context: {} as { orderId: string; total: number; chargeId?: string },
      events: {} as { type: "PAY" } | { type: "CANCEL" },
      input: {} as { orderId: string; total: number },
    },
    actors: {
      processPayment: fromPromise(
        async ({ input }: { input: { total: number } }) => {
          return { chargeId: `ch_${input.total}` };
        },
      ),
    },
  }).createMachine({
    id,
    initial: "pending",
    context: ({ input }) => ({ orderId: input.orderId, total: input.total }),
    states: {
      pending: {
        ...durableState(),
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
          onError: "failed",
        },
      },
      paid: { type: "final" },
      cancelled: { type: "final" },
      failed: { type: "final" },
    },
  });
}
