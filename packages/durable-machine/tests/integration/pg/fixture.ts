import pg from "pg";
import { createDurableMachine, createStore, createStoreInstruments, getVisualizationState as pgGetVisualizationState } from "../../../src/pg/index.js";
import type { StoreInstruments } from "../../../src/pg/index.js";
import type { PgDurableMachine } from "../../../src/pg/create-durable-machine.js";
import type { BackendFixture } from "../../fixtures/helpers.js";
import type { EffectHandler, ResolvedEffect } from "../../../src/effects.js";
import { TEST_DB_URL } from "../../test-db.js";

export function createPgFixture(opts?: {
  useBatchProcessing?: boolean;
  poolSize?: number;
  /** When true, creates OTel instruments from the global MeterProvider during setup(). */
  enableMetrics?: boolean;
}): BackendFixture {
  const pool = new pg.Pool({
    connectionString: TEST_DB_URL,
    ...(opts?.poolSize != null ? { max: opts.poolSize } : {}),
  });
  // Store is created lazily in setup() so OTel MeterProvider can be registered first
  let store: ReturnType<typeof createStore>;
  let instruments: StoreInstruments | undefined;
  const machines = new Map<string, PgDurableMachine>();
  const allEffectHandlers = new Map<string, EffectHandler>();
  let poller: ReturnType<typeof setInterval> | undefined;
  let effectPoller: ReturnType<typeof setInterval> | undefined;

  return {
    name: (() => {
      const base = opts?.useBatchProcessing === false ? "pg-legacy" : "pg";
      if (opts?.poolSize != null) return `${base} pool=${opts.poolSize}`;
      return base;
    })(),

    async setup() {
      if (opts?.enableMetrics) {
        instruments = createStoreInstruments(pool);
      }
      store = createStore({ pool, useListenNotify: false, instruments });
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
        useBatchProcessing: opts?.useBatchProcessing,
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
      const rows = await store.claimPendingTasks(50);
      for (const row of rows) {
        const handler = allEffectHandlers.get(row.effectType);
        if (!handler) {
          await store.markEffectFailed(row.id, `No handler for "${row.effectType}"`, null);
          continue;
        }
        try {
          await handler(
            { type: row.effectType, ...row.effectPayload } as ResolvedEffect,
            { tenantId: row.tenantId },
          );
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
      await pool.query(`SELECT fire_due_timeouts()`);
      // The PG function inserts into event_log which triggers NOTIFY.
      // In test mode (no LISTEN), we need to process events for instances
      // that had timeouts expire.
      const { rows } = await pool.query(
        `SELECT DISTINCT el.instance_id, mi.machine_name
         FROM event_log el
         JOIN machine_instances mi ON mi.id = el.instance_id
         WHERE el.source = 'system:timeout'
           AND el.seq > mi.event_cursor
           AND mi.status = 'running'`,
      );
      for (const row of rows) {
        const m = machines.get(row.machine_name);
        if (!m) continue;
        try { await m.consumeAndProcess(row.instance_id); } catch { /* retry */ }
      }
    } catch {
      // poll errors silently ignored
    }
  }
}
