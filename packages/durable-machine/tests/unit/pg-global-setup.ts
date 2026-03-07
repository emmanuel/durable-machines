import pg from "pg";
import { createStore } from "../../src/pg/store.js";

const TEST_DB_URL =
  process.env.PG_TEST_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

export async function setup() {
  const pool = new pg.Pool({ connectionString: TEST_DB_URL });
  const store = createStore({ pool, useListenNotify: false });
  await store.ensureSchema();
  await store.close();
  await pool.end();
}
