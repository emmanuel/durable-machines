import { setup } from "xstate";
import { quiescent, prompt } from "@xstate-dbos/durable-state-machine";

export const approvalMachine = setup({
  types: {
    context: {} as { requestId: string; requester: string; description: string },
    input: {} as { requestId: string; requester: string; description: string },
  },
}).createMachine({
  id: "approval",
  initial: "pending_review",
  context: ({ input }) => input,
  states: {
    pending_review: {
      ...quiescent(),
      ...prompt({
        type: "choice",
        text: ({ context }) =>
          `Approve request from ${context.requester}? "${context.description}"`,
        options: [
          { label: "Approve", event: "APPROVE", style: "primary" },
          { label: "Reject", event: "REJECT", style: "danger" },
        ],
      }),
      on: {
        APPROVE: "approved",
        REJECT: "rejected",
      },
    },
    approved: { type: "final" },
    rejected: { type: "final" },
  },
});
