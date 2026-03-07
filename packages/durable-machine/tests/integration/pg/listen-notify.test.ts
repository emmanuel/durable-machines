import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { setup, assign } from "xstate";
import { durableState } from "../../../src/durable-state.js";
import { createDurableMachine, createStore, sendMachineEvent } from "../../../src/pg/index.js";
import type { PgStore } from "../../../src/pg/store.js";
import { waitForState } from "../../fixtures/helpers.js";

const TEST_DB_URL =
  process.env.PG_TEST_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

const listenMachine = setup({
  types: {
    context: {} as { step: string },
    events: {} as { type: "PAY" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "listenTest",
  initial: "pending",
  context: { step: "initial" },
  states: {
    pending: {
      ...durableState(),
      on: {
        PAY: {
          target: "paid",
          actions: assign({ step: "paid" }),
        },
      },
    },
    paid: { type: "final" },
  },
});

describe("LISTEN/NOTIFY [pg]", () => {
  let pool: pg.Pool;
  let store: PgStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    store = createStore({ pool, useListenNotify: true });
    await store.ensureSchema();
    await pool.query("TRUNCATE machine_instances CASCADE");
  });

  afterAll(async () => {
    await pool.query("TRUNCATE machine_instances CASCADE");
    await store.close();
    await pool.end();
  });

  it("processes events via LISTEN/NOTIFY", async () => {
    const durable = createDurableMachine(listenMachine, {
      pool,
      store,
      useListenNotify: true,
      wakePollingIntervalMs: 500,
    });

    const id = `ln-${Date.now()}`;
    const handle = await durable.start(id, {});
    await waitForState(handle, "pending");

    // Send event via external client (direct SQL INSERT)
    await sendMachineEvent(pool, id, { type: "PAY" });

    // Wait a bit for NOTIFY to trigger processing
    await new Promise((r) => setTimeout(r, 1000));

    // The handle's send() also processes inline, but here we test the external path
    // If LISTEN/NOTIFY is working, the state should transition
    // Give it a few seconds to process
    await waitForState(handle, "paid", 5000);

    const state = await handle.getState();
    expect(state!.value).toBe("paid");
  });
});
