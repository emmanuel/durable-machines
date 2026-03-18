import pg from "pg";
import { createStore } from "../../src/pg/store.js";

export async function setup() {
  const url = process.env.PG_TEST_DATABASE_URL;
  if (!url) return; // Unit tests use in-memory PGlite; skip when no PG URL

  const pool = new pg.Pool({ connectionString: url });
  await pool.query(`
    DROP TABLE IF EXISTS effect_outbox CASCADE;
    DROP TABLE IF EXISTS transition_log CASCADE;
    DROP TABLE IF EXISTS event_log CASCADE;
    DROP TABLE IF EXISTS step_cache CASCADE;
    DROP TABLE IF EXISTS machine_instances CASCADE;
    DROP TABLE IF EXISTS tenants CASCADE;
  `);
  const store = createStore({ pool, useListenNotify: false });
  await store.ensureSchema();
  await store.ensureRoles();
  await store.close();
  await pool.end();
}
