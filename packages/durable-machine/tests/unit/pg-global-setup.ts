import pg from "pg";
import { createStore } from "../../src/pg/store.js";

const TEST_DB_URL =
  process.env.PG_TEST_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

export async function setup() {
  const pool = new pg.Pool({ connectionString: TEST_DB_URL });
  await pool.query(`
    DROP TABLE IF EXISTS effect_outbox CASCADE;
    DROP TABLE IF EXISTS transition_log CASCADE;
    DROP TABLE IF EXISTS event_log CASCADE;
    DROP TABLE IF EXISTS invoke_results CASCADE;
    DROP TABLE IF EXISTS machine_instances CASCADE;
  `);
  const store = createStore({ pool, useListenNotify: false });
  await store.ensureSchema();
  await store.close();
  await pool.end();
}
