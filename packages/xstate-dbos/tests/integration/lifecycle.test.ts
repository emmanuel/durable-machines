import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { setup, fromPromise, assign } from "xstate";
import { createDurableMachine, quiescent } from "../../src/index.js";

const SYSTEM_DB_URL =
  process.env.DBOS_SYSTEM_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

// ─── Test Machine ───────────────────────────────────────────────────────────

const orderMachine = setup({
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

// ─── Register BEFORE launch (DBOS requirement) ─────────────────────────────

DBOS.setConfig({
  name: "lifecycle-test",
  systemDatabaseUrl: SYSTEM_DB_URL,
});

const durable = createDurableMachine(orderMachine);

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  await DBOS.launch();
});

afterAll(async () => {
  // Cancel any pending workflows (including recovered ones from previous runs)
  // to avoid blocking shutdown
  const pending = await DBOS.listWorkflows({ status: "PENDING" as any });
  await Promise.all(pending.map((w) => DBOS.cancelWorkflow(w.workflowID)));
  await DBOS.shutdown({ deregister: true });
});

// ─── Helper ─────────────────────────────────────────────────────────────────

async function waitForState(
  handle: { getState(): Promise<{ value: unknown } | null> },
  expected: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await handle.getState();
    if (state && JSON.stringify(state.value) === JSON.stringify(expected)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for state "${expected}"`);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("lifecycle", () => {
  it("starts a machine and reaches initial quiescent state", async () => {
    const id = `lifecycle-init-${Date.now()}`;
    const handle = await durable.start(id, { orderId: "o1", total: 50 });

    await waitForState(handle, "pending");
    const state = await handle.getState();
    expect(state).not.toBeNull();
    expect(state!.value).toBe("pending");
    expect(state!.status).toBe("running");
    expect(state!.context).toMatchObject({ orderId: "o1", total: 50 });
  });

  it("sends an event and transitions through invoke to next quiescent state", async () => {
    const id = `lifecycle-pay-${Date.now()}`;
    const handle = await durable.start(id, { orderId: "o2", total: 99.99 });

    await waitForState(handle, "pending");
    await handle.send({ type: "PAY" });
    await waitForState(handle, "paid");

    const state = await handle.getState();
    expect(state!.value).toBe("paid");
    expect(state!.context).toMatchObject({
      orderId: "o2",
      total: 99.99,
      chargeId: "ch_99.99",
    });
  });

  it("completes full lifecycle: pending → pay → paid → ship → delivered", async () => {
    const id = `lifecycle-full-${Date.now()}`;
    const handle = await durable.start(id, { orderId: "o3", total: 25 });

    await waitForState(handle, "pending");
    await handle.send({ type: "PAY" });
    await waitForState(handle, "paid");
    await handle.send({ type: "SHIP" });

    const result = await handle.getResult();
    expect(result).toMatchObject({
      orderId: "o3",
      total: 25,
      chargeId: "ch_25",
      trackingNumber: "tr_o3",
    });
  });

  it("can cancel from initial state", async () => {
    const id = `lifecycle-cancel-${Date.now()}`;
    const handle = await durable.start(id, { orderId: "o4", total: 10 });

    await waitForState(handle, "pending");
    await handle.send({ type: "CANCEL" });

    const result = await handle.getResult();
    expect(result).toMatchObject({ orderId: "o4", total: 10 });
  });

  it("retrieves an existing machine handle via get()", async () => {
    const id = `lifecycle-get-${Date.now()}`;
    await durable.start(id, { orderId: "o5", total: 30 });

    const handle = durable.get(id);
    await waitForState(handle, "pending");
    const state = await handle.getState();
    expect(state!.value).toBe("pending");
  });

  it("returns step history via getSteps()", async () => {
    const id = `lifecycle-steps-${Date.now()}`;
    const handle = await durable.start(id, { orderId: "o6", total: 42 });

    await waitForState(handle, "pending");
    await handle.send({ type: "PAY" });
    await waitForState(handle, "paid");

    const steps = await handle.getSteps();
    expect(steps.length).toBeGreaterThan(0);

    const invokeStep = steps.find((s) => s.name === "invoke:processPayment");
    expect(invokeStep).toBeDefined();
    expect(invokeStep!.output).toMatchObject({ chargeId: "ch_42" });
  });
});
