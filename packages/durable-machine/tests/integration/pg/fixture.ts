import pg from "pg";
import { createDurableMachine, createStore, getVisualizationState as pgGetVisualizationState } from "../../../src/pg/index.js";
import type { BackendFixture } from "../../fixtures/helpers.js";

const TEST_DB_URL =
  process.env.PG_TEST_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

export function createPgFixture(): BackendFixture {
  // Create pool and store eagerly so createMachine() works before setup()
  const pool = new pg.Pool({ connectionString: TEST_DB_URL });
  const store = createStore({ pool, useListenNotify: false });

  return {
    name: "pg",

    async setup() {
      await store.ensureSchema();
      await pool.query("TRUNCATE machine_instances CASCADE");
    },

    async teardown() {
      await pool.query("TRUNCATE machine_instances CASCADE");
      await store.close();
      await pool.end();
    },

    createMachine(machine, options) {
      return createDurableMachine(machine, {
        pool,
        store,
        useListenNotify: false,
        wakePollingIntervalMs: 500,
        ...options,
      });
    },

    async getVisualizationState(machine, workflowId) {
      return pgGetVisualizationState(machine, workflowId, store);
    },
  };
}
