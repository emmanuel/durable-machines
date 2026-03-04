import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { setup, assign } from "xstate";
import {
  createDurableMachine,
  prompt,
  consoleChannel,
} from "../../src/index.js";

const SYSTEM_DB_URL =
  process.env.DBOS_SYSTEM_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

// ─── Test Machines ─────────────────────────────────────────────────────────

// Choice prompt — approve or reject
const approvalMachine = setup({
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

// Multi-step machine with prompts in multiple states
const multiStepMachine = setup({
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

// Dynamic prompt text with context
const dynamicPromptMachine = setup({
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

// Machine with timeout and prompt — tests prompt resolution on timeout
const promptWithTimeoutMachine = setup({
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

// ─── Register BEFORE launch ────────────────────────────────────────────────

DBOS.setConfig({
  name: "prompt-test",
  systemDatabaseUrl: SYSTEM_DB_URL,
});

const approvalChannel = consoleChannel();
const durableApproval = createDurableMachine(approvalMachine, {
  channels: [approvalChannel],
});

const multiStepChannel = consoleChannel();
const durableMultiStep = createDurableMachine(multiStepMachine, {
  channels: [multiStepChannel],
});

const dynamicChannel = consoleChannel();
const durableDynamic = createDurableMachine(dynamicPromptMachine, {
  channels: [dynamicChannel],
});

const timeoutChannel = consoleChannel();
const durableTimeout = createDurableMachine(promptWithTimeoutMachine, {
  channels: [timeoutChannel],
});

// No-channel variant — same machine, no channels
const durableNoChannel = createDurableMachine(approvalMachine);

// ─── Setup / Teardown ──────────────────────────────────────────────────────

beforeAll(async () => {
  await DBOS.launch();
});

afterAll(async () => {
  const pending = await DBOS.listWorkflows({ status: "PENDING" as any });
  await Promise.all(pending.map((w) => DBOS.cancelWorkflow(w.workflowID)));
  await DBOS.shutdown({ deregister: true });
});

// ─── Helper ────────────────────────────────────────────────────────────────

async function waitForState(
  handle: { getState(): Promise<{ value: unknown } | null> },
  expected: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await handle.getState();
    if (state && JSON.stringify(state.value) === JSON.stringify(expected)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for state "${expected}"`);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("prompt & channel adapters", () => {
  it("sends a prompt to the channel when entering a quiescent state", async () => {
    const id = `prompt-send-${Date.now()}`;
    const handle = await durableApproval.start(id, {});

    await waitForState(handle, "pending");

    // Allow a moment for the prompt step to execute
    await new Promise((r) => setTimeout(r, 500));

    expect(approvalChannel.prompts.length).toBeGreaterThanOrEqual(1);
    const sent = approvalChannel.prompts.find((p) => p.workflowId === id);
    expect(sent).toBeDefined();
    expect(sent!.prompt.type).toBe("choice");
    expect(sent!.prompt.text).toBe("Do you approve this request?");

    // Clean up — send event to complete workflow
    await handle.send({ type: "APPROVE" });
    await handle.getResult();
  });

  it("resolves the prompt after a transition", async () => {
    const id = `prompt-resolve-${Date.now()}`;
    const handle = await durableApproval.start(id, {});

    await waitForState(handle, "pending");
    await new Promise((r) => setTimeout(r, 500));

    await handle.send({ type: "REJECT" });
    const result = await handle.getResult();

    expect(result).toMatchObject({ decision: "rejected" });

    const sent = approvalChannel.prompts.find((p) => p.workflowId === id);
    expect(sent).toBeDefined();
    expect(sent!.resolvedWith).toBeDefined();
    expect(sent!.resolvedWith!.newStateValue).toBe("rejected");
  });

  it("works without channels (no prompt sent)", async () => {
    const id = `no-channel-${Date.now()}`;
    const handle = await durableNoChannel.start(id, {});

    await waitForState(handle, "pending");
    await handle.send({ type: "APPROVE" });

    const result = await handle.getResult();
    expect(result).toMatchObject({ decision: "approved" });
  });

  it("sends prompts for each state in a multi-step flow", async () => {
    const id = `multi-step-${Date.now()}`;
    const handle = await durableMultiStep.start(id, {});

    await waitForState(handle, "step1");
    await new Promise((r) => setTimeout(r, 500));

    await handle.send({ type: "NEXT" });
    await waitForState(handle, "step2");
    await new Promise((r) => setTimeout(r, 500));

    await handle.send({ type: "NEXT" });
    const result = await handle.getResult();

    expect(result).toMatchObject({ step: 3 });

    // Should have at least 2 prompts (one per quiescent state)
    const myPrompts = multiStepChannel.prompts.filter((p) => p.workflowId === id);
    expect(myPrompts.length).toBeGreaterThanOrEqual(2);
  });

  it("passes snapshot context to the channel", async () => {
    const id = `dynamic-ctx-${Date.now()}`;
    const handle = await durableDynamic.start(id, { name: "Alice" });

    await waitForState(handle, "confirming");
    await new Promise((r) => setTimeout(r, 500));

    const sent = dynamicChannel.prompts.find((p) => p.workflowId === id);
    expect(sent).toBeDefined();
    expect(sent!.context).toMatchObject({ name: "Alice" });

    await handle.send({ type: "CONFIRM" });
    const result = await handle.getResult();
    expect(result).toMatchObject({ confirmed: true });
  });

  it("resolves prompt when after timeout fires", async () => {
    const id = `prompt-timeout-${Date.now()}`;
    const handle = await durableTimeout.start(id, {});

    // Let the 1s timeout fire
    const result = await handle.getResult();

    expect(result).toMatchObject({ timedOut: true });

    const sent = timeoutChannel.prompts.find((p) => p.workflowId === id);
    expect(sent).toBeDefined();
    // Prompt should be resolved (state changed from waiting to timedOut)
    expect(sent!.resolvedWith).toBeDefined();
    expect(sent!.resolvedWith!.newStateValue).toBe("timedOut");
  });
});
