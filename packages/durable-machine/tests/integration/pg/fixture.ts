import pg from "pg";
import { createDurableMachine, createStore, getVisualizationState as pgGetVisualizationState } from "../../../src/pg/index.js";
import type { PgDurableMachine } from "../../../src/pg/create-durable-machine.js";
import type { BackendFixture } from "../../fixtures/helpers.js";

const TEST_DB_URL =
  process.env.PG_TEST_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

export function createPgFixture(): BackendFixture {
  // Create pool and store eagerly so createMachine() works before setup()
  const pool = new pg.Pool({ connectionString: TEST_DB_URL });
  const store = createStore({ pool, useListenNotify: false });
  const machines = new Map<string, PgDurableMachine>();
  let poller: ReturnType<typeof setInterval> | undefined;

  return {
    name: "pg",

    async setup() {
      await store.ensureSchema();
      await pool.query("TRUNCATE machine_instances CASCADE");

      // Start a timeout poller for after-transition tests
      poller = setInterval(() => {
        void pollTimeouts();
      }, 500);
      poller.unref();
    },

    async teardown() {
      if (poller) clearInterval(poller);
      await pool.query("TRUNCATE machine_instances CASCADE");
      await store.close();
      await pool.end();
    },

    createMachine(machine, options) {
      const dm = createDurableMachine(machine, {
        pool,
        store,
        useListenNotify: false,
        ...options,
      });
      machines.set(machine.id, dm);
      return dm;
    },

    async getVisualizationState(machine, workflowId) {
      return pgGetVisualizationState(machine, workflowId, store);
    },
  };

  async function pollTimeouts(): Promise<void> {
    try {
      const now = Date.now();
      const { rows } = await pool.query(
        `SELECT id, machine_name FROM machine_instances
         WHERE wake_at <= $1 AND status = 'running'
         ORDER BY wake_at ASC LIMIT 50`,
        [now],
      );
      for (const row of rows) {
        const m = machines.get(row.machine_name);
        if (m) {
          try {
            await m.processTimeout(row.id);
          } catch {
            // individual failures don't stop the poller
          }
        }
      }
    } catch {
      // poll errors silently ignored
    }
  }
}
