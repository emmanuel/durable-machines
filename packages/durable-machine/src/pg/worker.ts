import { Pool } from "pg";
import type { Pool as PoolType } from "pg";
import type { AnyStateMachine } from "xstate";
import type {
  WorkerAppContext,
  DurableMachine,
  DurableMachineOptions,
} from "../types.js";
import type { EffectHandler, ResolvedEffect } from "../effects.js";
import { createAppContext } from "../app-context.js";
import { createStore } from "./store.js";
import type { PgStore } from "./store.js";
import { createDurableMachine } from "./create-durable-machine.js";
import type { PgDurableMachine } from "./create-durable-machine.js";
import type { PgConfig } from "./config.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PgWorkerAppContext = WorkerAppContext & {
  readonly pool: PoolType;
  readonly store: PgStore;
  /** Live registry of all machines registered via {@link WorkerAppContext.register}. Entries are added dynamically; consumers see updates immediately. */
  readonly machines: ReadonlyMap<string, DurableMachine>;
};

// ─── Factory ────────────────────────────────────────────────────────────────

export function createPgWorkerContext(config: PgConfig): PgWorkerAppContext {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.poolSize ?? 20,
  });
  const store = createStore({
    pool,
    schema: config.schema,
    useListenNotify: config.useListenNotify,
  });

  const machines = new Map<string, PgDurableMachine>();
  const allEffectHandlers = new Map<string, EffectHandler>();
  let wakePoller: { stop: () => void } | null = null;
  let effectPoller: { stop: () => void } | null = null;

  // ── Semaphore for cross-instance concurrency control ────────────────

  const maxConcurrency = config.maxConcurrency ?? 10;
  let permits = maxConcurrency;
  const waitQueue: Array<() => void> = [];

  function acquirePermit(): Promise<void> {
    if (permits > 0) { permits--; return Promise.resolve(); }
    return new Promise<void>((resolve) => waitQueue.push(resolve));
  }

  function releasePermit(): void {
    const next = waitQueue.shift();
    if (next) next(); else permits++;
  }

  function dispatch(instanceId: string, dm: PgDurableMachine): void {
    void acquirePermit().then(async () => {
      try { await dm.consumeAndProcess(instanceId); }
      finally { releasePermit(); }
    });
  }

  // ── Adaptive Poller ────────────────────────────────────────────────────

  function adaptivePoll(
    pollFn: () => Promise<number>,
    opts: { minMs: number; maxMs: number; factor: number },
  ): { stop: () => void } {
    let currentMs = opts.maxMs;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function tick(): Promise<void> {
      if (stopped) return;
      try {
        const count = await pollFn();
        currentMs = count > 0
          ? opts.minMs
          : Math.min(currentMs * opts.factor, opts.maxMs);
      } catch { /* ignore */ }
      if (!stopped) {
        timer = setTimeout(() => void tick(), currentMs);
        timer.unref();
      }
    }
    timer = setTimeout(() => void tick(), opts.minMs);
    timer.unref();
    return {
      stop() {
        stopped = true;
        clearTimeout(timer);
      },
    };
  }

  // ── Poll for timed-out instances ────────────────────────────────────────

  async function pollTimeouts(): Promise<number> {
    try {
      const { rows } = await pool.query(`SELECT fire_due_timeouts() AS cnt`);
      return Number(rows[0].cnt);
    } catch {
      return 0;
    }
  }

  // ── Poll for pending effects ─────────────────────────────────────────────

  function computeBackoff(attempt: number): number {
    const baseMs = 1000;
    const rate = 2;
    return baseMs * rate ** (attempt - 1);
  }

  async function pollEffects(): Promise<number> {
    if (allEffectHandlers.size === 0) return 0;

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
          const nextRetry = exhausted
            ? null
            : Date.now() + computeBackoff(row.attempts);
          await store.markEffectFailed(
            row.id,
            err instanceof Error ? err.message : String(err),
            nextRetry,
          );
        }
      }
      return rows.length;
    } catch {
      return 0;
    }
  }

  // ── Backend for createAppContext ────────────────────────────────────────

  const backend = {
    async start(): Promise<void> {
      await store.ensureSchema();

      await store.startListening(
        (machineName: string, instanceId: string, _topic: string) => {
          const dm = machines.get(machineName);
          if (!dm) return;
          dispatch(instanceId, dm);
        },
      );

      wakePoller = adaptivePoll(pollTimeouts, {
        minMs: 500,
        maxMs: config.wakePollingIntervalMs ?? 5000,
        factor: 2,
      });

      effectPoller = adaptivePoll(pollEffects, {
        minMs: 100,
        maxMs: config.effectPollingIntervalMs ?? 1000,
        factor: 2,
      });
    },

    async stop(): Promise<void> {
      wakePoller?.stop();
      wakePoller = null;
      effectPoller?.stop();
      effectPoller = null;
      await store.close();
      await pool.end();
    },
  };

  const appContext = createAppContext(backend);

  // ── Register ───────────────────────────────────────────────────────────

  function register<T extends AnyStateMachine>(
    machine: T,
    options?: DurableMachineOptions,
  ): DurableMachine<T> {
    if (machines.has(machine.id)) {
      throw new Error(`Machine "${machine.id}" is already registered`);
    }

    const dm = createDurableMachine(machine, {
      pool,
      store,
      ...options,
    });

    machines.set(machine.id, dm);

    // Merge effect handlers into the shared handler map
    if (options?.effectHandlers) {
      for (const [type, handler] of options.effectHandlers.handlers) {
        allEffectHandlers.set(type, handler);
      }
    }

    // Return as DurableMachine (hides PgDurableMachine internals)
    return dm as DurableMachine<T>;
  }

  return {
    start: appContext.start,
    shutdown: appContext.shutdown,
    isShuttingDown: appContext.isShuttingDown,
    register,
    machines,
    pool,
    store,
  };
}
