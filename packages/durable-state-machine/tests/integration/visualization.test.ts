import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { setup, fromPromise, assign } from "xstate";
import {
  createDurableMachine,
  quiescent,
  getVisualizationState,
} from "../../src/index.js";

const SYSTEM_DB_URL =
  process.env.DBOS_SYSTEM_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

// ─── Test Machines ──────────────────────────────────────────────────────────

function makeVizMachine(id: string) {
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
          onError: "failed",
        },
      },
      paid: { type: "final" },
      cancelled: { type: "final" },
      failed: { type: "final" },
    },
  });
}

const vizMachine = makeVizMachine("vizOrder");
const vizMachineNoStream = makeVizMachine("vizOrderNoStream");

// ─── Register BEFORE launch ────────────────────────────────────────────────

DBOS.setConfig({
  name: "visualization-test",
  systemDatabaseUrl: SYSTEM_DB_URL,
});

const durable = createDurableMachine(vizMachine, {
  enableTransitionStream: true,
});

// Separate machine ID to avoid workflow cache sharing
const durableNoStream = createDurableMachine(vizMachineNoStream);

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  await DBOS.launch();
});

afterAll(async () => {
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
    if (state && JSON.stringify(state.value) === JSON.stringify(expected))
      return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for state "${expected}"`);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("getVisualizationState()", () => {
  it("returns definition, current state, and transitions for a completed workflow", async () => {
    const id = `viz-complete-${Date.now()}`;
    const handle = await durable.start(id, { orderId: "v1", total: 42 });

    await waitForState(handle, "pending");
    await handle.send({ type: "PAY" });
    const result = await handle.getResult();
    expect(result).toMatchObject({ chargeId: "ch_42" });

    const viz = await getVisualizationState(vizMachine, id);

    // Definition
    expect(viz.definition.id).toBe("vizOrder");
    expect(viz.definition.initial).toBe("pending");
    expect(viz.definition.states["pending"].quiescent).toBe(true);

    // Current state (workflow is done, last published state)
    expect(viz.currentState).not.toBeNull();
    expect(viz.currentState!.status).toBe("done");

    // Transitions (stream was enabled)
    expect(viz.transitions.length).toBeGreaterThanOrEqual(2);
    expect(viz.transitions[0].from).toBeNull();
    expect(viz.transitions[0].to).toBe("pending");

    // State durations
    expect(viz.stateDurations.length).toBe(viz.transitions.length);
  });

  it("returns empty transitions when stream is not enabled", async () => {
    const id = `viz-no-stream-${Date.now()}`;
    const handle = await durableNoStream.start(id, {
      orderId: "v2",
      total: 10,
    });

    await waitForState(handle, "pending");
    await handle.send({ type: "CANCEL" });
    await handle.getResult();

    const viz = await getVisualizationState(vizMachineNoStream, id);

    // Definition still works
    expect(viz.definition.id).toBe("vizOrderNoStream");

    // Current state works
    expect(viz.currentState).not.toBeNull();

    // Transitions are empty (stream was not enabled)
    expect(viz.transitions).toEqual([]);
    expect(viz.stateDurations).toEqual([]);
  });

  it("shows current state and no active sleep for a quiescent machine", async () => {
    const id = `viz-quiescent-${Date.now()}`;
    const handle = await durable.start(id, { orderId: "v3", total: 20 });

    await waitForState(handle, "pending");

    const viz = await getVisualizationState(vizMachine, id);

    expect(viz.currentState).not.toBeNull();
    expect(viz.currentState!.value).toBe("pending");
    expect(viz.currentState!.status).toBe("running");
    expect(viz.activeSleep).toBeNull();

    // Clean up
    await handle.send({ type: "CANCEL" });
    await handle.getResult();
  });
});
