import pg from "pg";
import { createDurableMachine, createStore, getVisualizationState as pgGetVisualizationState } from "../../../src/pg/index.js";
import type { PgDurableMachine } from "../../../src/pg/create-durable-machine.js";
import type { BackendFixture } from "../../fixtures/helpers.js";
import type { EffectHandler, ResolvedEffect } from "../../../src/effects.js";
import { getSortedAfterDelays, buildAfterEvent } from "../../../src/xstate-utils.js";

const TEST_DB_URL =
  process.env.PG_TEST_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

export function createPgFixture(): BackendFixture {
  // Create pool and store eagerly so createMachine() works before setup()
  const pool = new pg.Pool({ connectionString: TEST_DB_URL });
  const store = createStore({ pool, useListenNotify: false });
  const machines = new Map<string, PgDurableMachine>();
  const allEffectHandlers = new Map<string, EffectHandler>();
  let poller: ReturnType<typeof setInterval> | undefined;
  let effectPoller: ReturnType<typeof setInterval> | undefined;

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

      // Start effect poller
      effectPoller = setInterval(() => {
        void pollEffects();
      }, 500);
      effectPoller.unref();
    },

    async teardown() {
      if (poller) clearInterval(poller);
      if (effectPoller) clearInterval(effectPoller);
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

      // Merge effect handlers for the fixture poller
      if (options?.effectHandlers) {
        for (const [type, handler] of options.effectHandlers.handlers) {
          allEffectHandlers.set(type, handler);
        }
      }

      return dm;
    },

    async getVisualizationState(machine, workflowId) {
      return pgGetVisualizationState(machine, workflowId, store);
    },
  };

  async function pollEffects(): Promise<void> {
    if (allEffectHandlers.size === 0) return;
    try {
      const rows = await store.claimPendingEffects(50);
      for (const row of rows) {
        const handler = allEffectHandlers.get(row.effectType);
        if (!handler) {
          await store.markEffectFailed(row.id, `No handler for "${row.effectType}"`, null);
          continue;
        }
        try {
          await handler({ type: row.effectType, ...row.effectPayload } as ResolvedEffect);
          await store.markEffectCompleted(row.id);
        } catch (err) {
          const exhausted = row.attempts >= row.maxAttempts;
          const baseMs = 1000;
          const nextRetry = exhausted ? null : Date.now() + baseMs * 2 ** (row.attempts - 1);
          await store.markEffectFailed(
            row.id,
            err instanceof Error ? err.message : String(err),
            nextRetry,
          );
        }
      }
    } catch {
      // poll errors silently ignored
    }
  }

  async function pollTimeouts(): Promise<void> {
    try {
      const now = Date.now();
      const { rows } = await pool.query(
        `SELECT id, machine_name, state_value, context, fired_delays
         FROM machine_instances
         WHERE wake_at <= $1 AND status = 'running'
         ORDER BY wake_at ASC LIMIT 50`,
        [now],
      );
      for (const row of rows) {
        const m = machines.get(row.machine_name);
        if (!m) continue;

        // Optimistic claim
        const { rowCount } = await pool.query(
          `UPDATE machine_instances SET wake_at = NULL
           WHERE id = $1 AND wake_at IS NOT NULL AND wake_at <= $2`,
          [row.id, now],
        );
        if (!rowCount) continue;

        try {
          const snapshot = m.machine.resolveState({
            value: row.state_value,
            context: row.context,
          });
          const allDelays = getSortedAfterDelays(m.machine, snapshot);
          const firedDelays = row.fired_delays as Array<string | number>;
          const unfired = allDelays.filter((d: string | number) => !firedDelays.includes(d));
          if (unfired.length === 0) continue;

          const afterEvent = buildAfterEvent(m.machine, snapshot, unfired[0]);
          await store.appendEvent(row.id, afterEvent, "timeout", "system:timeout");

          try { await m.consumeAndProcess(row.id); } catch { /* NOTIFY retry */ }
        } catch {
          // individual failures don't stop the poller
        }
      }
    } catch {
      // poll errors silently ignored
    }
  }
}
