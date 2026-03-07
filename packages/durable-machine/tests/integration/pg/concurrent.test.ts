import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { setup, assign } from "xstate";
import { durableState } from "../../../src/durable-state.js";
import { createDurableMachine, createStore } from "../../../src/pg/index.js";
import type { PgStore } from "../../../src/pg/store.js";
import { waitForState, waitForContext } from "../../fixtures/helpers.js";

const TEST_DB_URL =
  process.env.PG_TEST_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

const concurrentMachine = setup({
  types: {
    context: {} as { events: string[] },
    events: {} as { type: "EVENT_A" } | { type: "EVENT_B" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "concurrent",
  initial: "pending",
  context: { events: [] },
  states: {
    pending: {
      ...durableState(),
      on: {
        EVENT_A: {
          target: "gotA",
          actions: assign({
            events: ({ context }) => [...context.events, "A"],
          }),
        },
        EVENT_B: {
          target: "gotB",
          actions: assign({
            events: ({ context }) => [...context.events, "B"],
          }),
        },
      },
    },
    gotA: {
      ...durableState(),
      on: {
        EVENT_B: {
          target: "done",
          actions: assign({
            events: ({ context }) => [...context.events, "B"],
          }),
        },
      },
    },
    gotB: {
      ...durableState(),
      on: {
        EVENT_A: {
          target: "done",
          actions: assign({
            events: ({ context }) => [...context.events, "A"],
          }),
        },
      },
    },
    done: { type: "final" },
  },
});

describe("concurrent access [pg]", () => {
  let pool: pg.Pool;
  let store: PgStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    store = createStore({ pool, useListenNotify: false });
    await store.ensureSchema();
    await pool.query("TRUNCATE machine_instances CASCADE");
  });

  afterAll(async () => {
    await pool.query("TRUNCATE machine_instances CASCADE");
    await store.close();
    await pool.end();
  });

  it("handles concurrent sends without data loss", async () => {
    const durable = createDurableMachine(concurrentMachine, {
      pool,
      store,
      useListenNotify: false,
    });

    const handle = await durable.start(`concurrent-${Date.now()}`, {});
    await waitForState(handle, "pending");

    // Send two events concurrently
    await Promise.all([
      handle.send({ type: "EVENT_A" }),
      handle.send({ type: "EVENT_B" }),
    ]);

    // Wait for final state — both events should eventually be processed
    await waitForContext(handle, (ctx) => ctx.events.length >= 2, 10000);

    const state = await handle.getState();
    expect(state!.value).toBe("done");
    expect(state!.context).toMatchObject({
      events: expect.arrayContaining(["A", "B"]),
    });
  });
});
