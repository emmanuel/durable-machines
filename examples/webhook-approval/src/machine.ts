import { durableSetup, durableState, prompt } from "@durable-machines/machine";

export const approvalMachine = durableSetup({
  input: {
    requestId: "string",
    requester: "string",
    description: "string",
  },
  label: "Approval",
  description: "Simple approval/rejection workflow",
}).createMachine({
  id: "approval",
  initial: "pending_review",
  context: ({ input }) => input,
  states: {
    pending_review: {
      ...durableState(),
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
