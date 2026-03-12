import pg from "pg";
import { createStore } from "../../src/pg/store.js";
import { TEST_DB_URL } from "../test-db.js";

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
