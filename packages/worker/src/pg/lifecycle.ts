import pg from "pg";
import type { Pool as PoolType } from "pg";
import type { AnyStateMachine } from "xstate";
import type { WorkerAppContext, Logger } from "../types.js";
import type {
  DurableMachine,
  DurableMachineOptions,
} from "@durable-xstate/durable-machine";
import type { EffectHandler, ResolvedEffect } from "@durable-xstate/durable-machine";
import { createAppContext } from "@durable-xstate/durable-machine";
import { createStore } from "@durable-xstate/durable-machine/pg";
import type { PgStore } from "@durable-xstate/durable-machine/pg";
import { createDurableMachine } from "@durable-xstate/durable-machine/pg";
import type { PgDurableMachine } from "@durable-xstate/durable-machine/pg";
import type { PgConfig } from "@durable-xstate/durable-machine/pg";
import type { WorkerMetrics } from "../metrics.js";
import { createWorkerMetrics, startTimer } from "../metrics.js";
import {
  createWorkerContext,
  startWorker,
} from "../lifecycle.js";
import type {
  WorkerConfig,
  WorkerContextOptions,
  WorkerHandle,
} from "../lifecycle.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PgWorkerAppContext = WorkerAppContext & {
  readonly pool: PoolType;
  /** Live registry of all machines registered via {@link WorkerAppContext.register}. Entries are added dynamically; consumers see updates immediately. */
  readonly machines: ReadonlyMap<string, DurableMachine>;
};

export interface PgWorkerContextOptions {
  /** Pre-created metrics for runtime instrumentation. */
  metrics?: WorkerMetrics;
  /** Structured logger for operational events. Uses a no-op logger when omitted. */
  logger?: Logger;
}

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

// ─── Factory ────────────────────────────────────────────────────────────────

export function createPgWorkerContext(
  config: PgConfig,
  options?: PgWorkerContextOptions,
): PgWorkerAppContext {
  const metrics = options?.metrics;
  const logger = options?.logger ?? noopLogger;

  const pool = new pg.Pool({
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
  const maxQueueSize = maxConcurrency * 10;
  let permits = maxConcurrency;
  const waitQueue: Array<() => void> = [];

  function acquirePermit(): Promise<void> {
    if (permits > 0) { permits--; return Promise.resolve(); }
    if (waitQueue.length >= maxQueueSize) {
      return Promise.reject(new Error("Dispatch queue full"));
    }
    return new Promise<void>((resolve) => waitQueue.push(resolve));
  }

  function releasePermit(): void {
    const next = waitQueue.shift();
    if (next) next(); else permits++;
  }

  function dispatch(instanceId: string, dm: PgDurableMachine): void {
    void acquirePermit().then(async () => {
      metrics?.activeDispatches.add(1);
      const end = metrics ? startTimer(metrics.eventProcessDuration, { machine_id: dm.machine.id }) : undefined;
      try {
        await dm.consumeAndProcess(instanceId);
        metrics?.eventsProcessedTotal.add(1, { machine_id: dm.machine.id, status: "success" });
      } catch (err) {
        metrics?.eventsProcessedTotal.add(1, { machine_id: dm.machine.id, status: "error" });
        logger.error({ instanceId, machineId: dm.machine.id, err: String(err) }, "dispatch failed");
      } finally {
        end?.();
        metrics?.activeDispatches.add(-1);
        releasePermit();
      }
    }).catch((err) => {
      logger.warn({ instanceId, err: String(err) }, "dispatch skipped — queue full");
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
      } catch (err) {
        logger.error({ err: String(err) }, "adaptive poll tick failed");
      }
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
      const count = Number(rows[0].cnt);
      if (count > 0) {
        metrics?.pollItemsFound.add(count, { poll_type: "timeouts" });
      }
      return count;
    } catch (err) {
      logger.error({ err: String(err) }, "timeout poll failed");
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
      if (rows.length > 0) {
        metrics?.pollItemsFound.add(rows.length, { poll_type: "effects" });
      }
      for (const row of rows) {
        const handler = allEffectHandlers.get(row.effectType);
        if (!handler) {
          await store.markEffectFailed(row.id, `No handler for "${row.effectType}"`, null);
          metrics?.effectsExecutedTotal.add(1, { effect_type: row.effectType, status: "no_handler" });
          logger.warn({ effectType: row.effectType }, "no handler for effect");
          continue;
        }

        const end = metrics ? startTimer(metrics.effectExecutionDuration, { effect_type: row.effectType }) : undefined;
        try {
          await handler(
            { type: row.effectType, ...row.effectPayload } as ResolvedEffect,
            { tenantId: row.tenantId },
          );
          await store.markEffectCompleted(row.id);
          metrics?.effectsExecutedTotal.add(1, { effect_type: row.effectType, status: "success" });
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
          metrics?.effectsExecutedTotal.add(1, { effect_type: row.effectType, status: "error" });
          logger.error({ effectType: row.effectType, err: String(err) }, "effect execution failed");
        } finally {
          end?.();
        }
      }
      return rows.length;
    } catch (err) {
      logger.error({ err: String(err) }, "effect poll failed");
      return 0;
    }
  }

  // ── Backend for createAppContext ────────────────────────────────────────

  const backend = {
    async start(): Promise<void> {
      await store.ensureSchema();

      // Recover effects stuck in "executing" from a previous crash (older than 5 min)
      const staleThreshold = Date.now() - 5 * 60 * 1000;
      const resetCount = await store.resetStaleEffects(staleThreshold);
      if (resetCount > 0) {
        logger.info({ count: resetCount }, "reset stale effects from previous crash");
      }

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

      logger.info({}, "PG worker backend started");
    },

    async stop(): Promise<void> {
      logger.info({}, "PG worker backend stopping");
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
    machineOptions?: DurableMachineOptions,
  ): DurableMachine<T> {
    if (machines.has(machine.id)) {
      throw new Error(`Machine "${machine.id}" is already registered`);
    }

    const dm = createDurableMachine(machine, {
      pool,
      store,
      ...machineOptions,
    });

    machines.set(machine.id, dm);

    // Merge effect handlers into the shared handler map
    if (machineOptions?.effectHandlers) {
      for (const [type, handler] of machineOptions.effectHandlers.handlers) {
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
  } satisfies PgWorkerAppContext;
}

// ─── Convenience ────────────────────────────────────────────────────────────

export interface PgWorkerStartOptions {
  pg: PgConfig;
  worker: WorkerConfig;
  machines: WorkerContextOptions["machines"];
  metrics?: WorkerMetrics;
  logger?: Logger;
}

export async function startPgWorker(
  options: PgWorkerStartOptions,
): Promise<PgWorkerAppContext & WorkerHandle> {
  const { pg, worker, machines, logger } = options;
  const metrics = options.metrics ?? (worker.adminPort != null ? createWorkerMetrics() : undefined);
  const appContext = createPgWorkerContext(pg, { metrics, logger });
  const ctx = createWorkerContext(worker, appContext, { machines, metrics });
  const handle = await startWorker(ctx);
  return { ...appContext, ...handle };
}
