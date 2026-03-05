import { setup, fromPromise } from "xstate";
import { quiescent, prompt } from "@xstate-dbos/durable-state-machine";

/**
 * Order processing state machine.
 *
 * Flow:
 *   pending ──APPROVE──> processing ──(done)──> awaiting_payment
 *   pending ──REJECT───> cancelled
 *   awaiting_payment ──PAY──> charging ──(done)──> paid
 *   awaiting_payment ──(30s)──> expired
 *   paid ──SHIP──> shipped
 */
export const orderMachine = setup({
  types: {
    context: {} as {
      orderId: string;
      total: number;
      paymentId?: string;
      error?: string;
    },
    input: {} as {
      orderId: string;
      total: number;
    },
    events: {} as
      | { type: "APPROVE" }
      | { type: "REJECT" }
      | { type: "PAY"; paymentMethod: string }
      | { type: "SHIP" },
  },
  actors: {
    processOrder: fromPromise(
      async ({ input }: { input: { orderId: string; total: number } }) => {
        // Simulate order validation / reservation
        console.log(
          `[processOrder] Validating order ${input.orderId} ($${input.total})`,
        );
        return { validated: true };
      },
    ),
    chargePayment: fromPromise(
      async ({
        input,
      }: {
        input: { orderId: string; total: number; paymentMethod: string };
      }) => {
        // Simulate payment charge
        console.log(
          `[chargePayment] Charging $${input.total} via ${input.paymentMethod}`,
        );
        return { paymentId: `PAY-${Date.now()}` };
      },
    ),
  },
}).createMachine({
  id: "order",
  context: ({ input }) => ({
    orderId: input.orderId,
    total: input.total,
  }),
  initial: "pending",
  states: {
    pending: {
      ...prompt({
        type: "choice",
        text: ({ context }) =>
          `Approve order ${context.orderId} for $${context.total}?`,
        options: [
          { label: "Approve", event: "APPROVE", style: "primary" },
          { label: "Reject", event: "REJECT", style: "danger" },
        ],
      }),
      on: {
        APPROVE: { target: "processing" },
        REJECT: { target: "cancelled" },
      },
    },

    processing: {
      invoke: {
        src: "processOrder",
        input: ({ context }) => ({
          orderId: context.orderId,
          total: context.total,
        }),
        onDone: { target: "awaiting_payment" },
        onError: {
          target: "cancelled",
          actions: ({ event }) => {
            console.error("[processing] Error:", event.error);
          },
        },
      },
    },

    awaiting_payment: {
      ...quiescent(),
      after: {
        30_000: { target: "expired" },
      },
      on: {
        PAY: { target: "charging" },
      },
    },

    charging: {
      invoke: {
        src: "chargePayment",
        input: ({ context, event }) => ({
          orderId: context.orderId,
          total: context.total,
          paymentMethod:
            event.type === "PAY"
              ? (event as { type: "PAY"; paymentMethod: string }).paymentMethod
              : "unknown",
        }),
        onDone: {
          target: "paid",
          actions: ({ context, event }) => {
            // In a real machine you would use `assign`; this is kept
            // simple for the example.
            (context as any).paymentId = (
              event.output as { paymentId: string }
            ).paymentId;
          },
        },
        onError: {
          target: "awaiting_payment",
          actions: ({ event }) => {
            console.error("[charging] Payment failed:", event.error);
          },
        },
      },
    },

    paid: {
      ...quiescent(),
      on: {
        SHIP: { target: "shipped" },
      },
    },

    shipped: {
      type: "final" as const,
    },

    expired: {
      type: "final" as const,
    },

    cancelled: {
      type: "final" as const,
    },
  },
});
