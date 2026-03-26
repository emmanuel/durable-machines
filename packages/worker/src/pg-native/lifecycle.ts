import pg from "pg";
import type { Pool as PoolType } from "pg";
import type { MachineDefinition, ImplementationRegistry, EffectHandler, ResolvedEffect, EffectHandlerContext } from "@durable-machines/machine";
import { createAppContext, DurableMachineError } from "@durable-machines/machine";
import { createStore } from "@durable-machines/machine/pg";
import type { TaskOutboxRow } from "@durable-machines/machine/pg";
import type { PgConfig } from "@durable-machines/machine/pg";
import {
  createNativeDurableMachine,
  Q_SEND_EVENT,
} from "@durable-machines/machine/pg-native";
import type { PgNativeDurableMachine } from "@durable-machines/machine/pg-native";
import type { WorkerMetrics } from "../metrics.js";
import { createWorkerMetrics } from "../metrics.js";
import type { Logger } from "../types.js";
import type {
  WorkerConfig,
  WorkerHandle,
} from "../lifecycle.js";
import { createAdminServer } from "../admin.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PgNativeWorkerConfig extends PgConfig {
  /** Maximum concurrent task executions. @defaultValue `10` */
  maxConcurrency?: number;
}

export interface NativeMachineRegistration {
  machineName: string;
  definition: MachineDefinition;
  registry?: ImplementationRegistry;
  effectHandlers?: { handlers: ReadonlyMap<string, EffectHandler> };
}

export interface PgNativeWorkerContextOptions {
  /** Pre-created metrics for runtime instrumentation. */
  metrics?: WorkerMetrics;
  /** Structured logger for operational events. Uses a no-op logger when omitted. */
  logger?: Logger;
}

export interface PgNativeWorkerAppContext {
  readonly pool: PoolType;
  readonly machines: ReadonlyMap<string, PgNativeDurableMachine>;
  register(registration: NativeMachineRegistration): PgNativeDurableMachine;
  start: (opts?: { servers?: import("node:http").Server[]; timeoutMs?: number }) => Promise<void>;
  shutdown: (reason?: string) => Promise<void>;
  isShuttingDown: () => boolean;
}

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

// ─── Actor Helpers ──────────────────────────────────────────────────────────

function resolveActorCreator(
  impl: any,
): (params: { input: unknown }) => Promise<unknown> {
  if (typeof impl?.config === "function") return impl.config;
  if (typeof impl === "function") return impl;
  throw new DurableMachineError(
    `Cannot resolve actor creator. Must be fromPromise() or async function. Got: ${typeof impl}`,
    "INTERNAL",
  );
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createPgNativeWorkerContext(
  config: PgNativeWorkerConfig,
  options?: PgNativeWorkerContextOptions,
): PgNativeWorkerAppContext {
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

  const machines = new Map<string, PgNativeDurableMachine>();
  const allEffectHandlers = new Map<string, EffectHandler>();
  let wakePoller: { stop: () => void } | null = null;
  let taskPoller: { stop: () => void; triggerNow: () => void } | null = null;

  // ── Semaphore for concurrency control ────────────────────────────────

  const maxConcurrency = config.maxConcurrency ?? 10;
  const maxQueueSize = maxConcurrency * 10;
  let permits = maxConcurrency;
  const waitQueue: Array<() => void> = [];

  function acquirePermit(): Promise<void> {
    if (permits > 0) { permits--; return Promise.resolve(); }
    if (waitQueue.length >= maxQueueSize) {
      return Promise.reject(new Error("Task queue full"));
    }
    return new Promise<void>((resolve) => waitQueue.push(resolve));
  }

  function releasePermit(): void {
    const next = waitQueue.shift();
    if (next) next(); else permits++;
  }

  // ── Adaptive Poller ──────────────────────────────────────────────────

  function adaptivePoll(
    pollFn: () => Promise<number>,
    opts: { minMs: number; maxMs: number; factor: number },
  ): { stop: () => void; triggerNow: () => void } {
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
      triggerNow() {
        if (stopped) return;
        clearTimeout(timer);
        currentMs = opts.minMs;
        timer = setTimeout(() => void tick(), 0);
        timer.unref();
      },
    };
  }

  // ── Execute Invoke (pg-native: uses dm_send_event) ───────────────────

  async function executeInvoke(row: TaskOutboxRow): Promise<void> {
    const idempotencyKey = `invoke:${row.id}`;

    // Step 1: Check if result event already exists (crash recovery dedup)
    const exists = await store.checkInvokeEventExists(row.instanceId, idempotencyKey);
    if (exists) {
      await store.markEffectCompleted(row.id);
      logger.debug({ taskId: row.id, invokeId: row.invokeId }, "invoke result already exists, skipping");
      // Drain via dm_process_events (result event already in log)
      await pool.query({
        name: "dm_native_process_events",
        text: `SELECT dm_process_events($1, $2)`,
        values: [row.instanceId, 50],
      });
      return;
    }

    // Step 2: Look up machine and actor implementation
    const machineName = row.machineName;
    if (!machineName) {
      await store.markEffectFailed(row.id, "Missing machine_name on invoke task", null);
      return;
    }

    const dm = machines.get(machineName);
    if (!dm) {
      await store.markEffectFailed(row.id, `No registered machine "${machineName}"`, null);
      return;
    }

    const invokeSrc = row.invokeSrc;
    if (!invokeSrc) {
      await store.markEffectFailed(row.id, "Missing invoke_src on invoke task", null);
      return;
    }

    // For pg-native, actors come from the ImplementationRegistry
    // which is stored on the options passed to createNativeDurableMachine.
    // We look up the dm and access its registry.
    const registry = (dm as any)._registry as ImplementationRegistry | undefined;
    const impl = registry?.actors[invokeSrc];
    if (!impl) {
      // Inject error event via dm_send_event
      const errorEventType = `xstate.error.actor.${row.invokeId}`;
      const errorPayload = {
        type: errorEventType,
        error: { message: `No actor implementation found for "${invokeSrc}". Ensure it is registered in the registry.` },
      };
      await pool.query({
        ...Q_SEND_EVENT,
        values: [row.instanceId, errorEventType, JSON.stringify(errorPayload), idempotencyKey],
      });
      await store.markEffectFailed(row.id, `No actor implementation for "${invokeSrc}"`, null);
      return;
    }

    // Step 3: Execute actor with timeout
    const invokeTimeoutMs = config.invokeTimeoutMs ?? 30_000;
    const creator = resolveActorCreator(impl);
    let output: unknown;
    let error: unknown;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), invokeTimeoutMs);

    try {
      const result = await Promise.race([
        creator({ input: row.invokeInput }).then(
          (out) => ({ output: out, error: undefined }),
          (err) => ({ output: undefined, error: err }),
        ),
        new Promise<{ output: undefined; error: Error }>((resolve) => {
          controller.signal.addEventListener("abort", () => {
            resolve({
              output: undefined,
              error: new Error(`Invocation "${invokeSrc}" timed out after ${invokeTimeoutMs}ms`),
            });
          });
        }),
      ]);

      output = result.output;
      error = result.error;
    } finally {
      clearTimeout(timeout);
    }

    // Step 4: Check if task was cancelled while executing
    const status = await store.checkTaskStatus(row.id);
    if (status === "cancelled") {
      logger.debug({ taskId: row.id, invokeId: row.invokeId }, "invoke task cancelled during execution");
      await store.markEffectCompleted(row.id);
      return;
    }

    // Step 5: Insert result event AND drain via dm_send_event
    const resultEventType = error != null
      ? `xstate.error.actor.${row.invokeId}`
      : `xstate.done.actor.${row.invokeId}`;
    const resultPayload = error != null
      ? { type: resultEventType, error: error instanceof Error ? { message: error.message } : error }
      : { type: resultEventType, output };

    await pool.query({
      ...Q_SEND_EVENT,
      values: [row.instanceId, resultEventType, JSON.stringify(resultPayload), idempotencyKey],
    });

    // Step 6: Mark task completed
    await store.markEffectCompleted(row.id);
  }

  // ── Execute Effect ───────────────────────────────────────────────────

  function computeBackoff(attempt: number): number {
    const baseMs = 1000;
    const rate = 2;
    return baseMs * rate ** (attempt - 1);
  }

  async function executeEffect(row: TaskOutboxRow): Promise<void> {
    const handler = allEffectHandlers.get(row.effectType);
    if (!handler) {
      await store.markEffectFailed(row.id, `No handler for "${row.effectType}"`, null);
      metrics?.effectsExecutedTotal.add(1, { effect_type: row.effectType, status: "no_handler" });
      logger.warn({ effectType: row.effectType }, "no handler for effect");
      return;
    }

    const startTime = performance.now();
    try {
      const ctx: EffectHandlerContext = { tenantId: row.tenantId };
      await handler(
        { type: row.effectType, ...row.effectPayload } as ResolvedEffect,
        ctx,
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
      const elapsed = performance.now() - startTime;
      metrics?.effectExecutionDuration.record(elapsed, { effect_type: row.effectType });
    }
  }

  // ── Execute Task (router) ────────────────────────────────────────────

  async function executeTask(row: TaskOutboxRow): Promise<void> {
    await acquirePermit();
    try {
      if (row.taskKind === "invoke") {
        await executeInvoke(row);
      } else {
        await executeEffect(row);
      }
    } finally {
      releasePermit();
    }
  }

  // ── Poll for timeout-affected instances (native) ─────────────────────

  async function pollTimeouts(): Promise<number> {
    try {
      const { rows } = await pool.query(
        `SELECT instance_id FROM fire_due_timeouts_native()`,
      );
      if (rows.length > 0) {
        metrics?.pollItemsFound.add(rows.length, { poll_type: "timeouts" });
        // Drain pending events for each affected instance
        for (const row of rows) {
          await pool.query({
            name: "dm_native_process_events",
            text: `SELECT dm_process_events($1, $2)`,
            values: [row.instance_id, 50],
          });
        }
      }
      return rows.length;
    } catch (err) {
      logger.error({ err: String(err) }, "timeout poll failed");
      return 0;
    }
  }

  // ── Unified Task Poller (effects + invokes) ──────────────────────────

  async function pollTasks(): Promise<number> {
    try {
      const rows = await store.claimPendingTasks(50);
      if (rows.length > 0) {
        metrics?.pollItemsFound.add(rows.length, { poll_type: "tasks" });
      }

      for (const row of rows) {
        await executeTask(row);
      }

      return rows.length;
    } catch (err) {
      logger.error({ err: String(err) }, "task poll failed");
      return 0;
    }
  }

  // ── Backend for createAppContext ──────────────────────────────────────

  const backend = {
    async start(): Promise<void> {
      await store.ensureSchema();

      // Recover tasks stuck in "executing" from a previous crash (older than 5 min)
      const staleThreshold = Date.now() - 5 * 60 * 1000;
      const resetCount = await store.resetStaleEffects(staleThreshold);
      if (resetCount > 0) {
        logger.info({ count: resetCount }, "reset stale tasks from previous crash");
      }

      // pg-native worker only listens on effect_pending (evaluation happens in PG)
      await store.startListening(
        // Event callback — no-op for pg-native (evaluation is in PG)
        (_machineName: string, _instanceId: string, _topic: string) => {},
        // Task callback — trigger task poller immediately on new outbox task
        (_instanceId: string) => {
          taskPoller?.triggerNow();
        },
      );

      wakePoller = adaptivePoll(pollTimeouts, {
        minMs: 500,
        maxMs: config.wakePollingIntervalMs ?? 5000,
        factor: 2,
      });

      taskPoller = adaptivePoll(pollTasks, {
        minMs: 100,
        maxMs: config.effectPollingIntervalMs ?? 1000,
        factor: 2,
      });

      logger.info({}, "PG-native worker backend started");
    },

    async stop(): Promise<void> {
      logger.info({}, "PG-native worker backend stopping");
      wakePoller?.stop();
      wakePoller = null;
      taskPoller?.stop();
      taskPoller = null;
      await store.close();
      await pool.end();
    },
  };

  const appContext = createAppContext(backend);

  // ── Register ─────────────────────────────────────────────────────────

  function register(registration: NativeMachineRegistration): PgNativeDurableMachine {
    if (machines.has(registration.machineName)) {
      throw new Error(`Machine "${registration.machineName}" is already registered`);
    }

    const dm = createNativeDurableMachine({
      pool,
      store,
      machineName: registration.machineName,
      definition: registration.definition,
      registry: registration.registry,
    });

    // Expose registry on dm for invoke execution lookup
    (dm as any)._registry = registration.registry;

    machines.set(registration.machineName, dm);

    // Merge effect handlers into the shared handler map
    if (registration.effectHandlers) {
      for (const [type, handler] of registration.effectHandlers.handlers) {
        allEffectHandlers.set(type, handler);
      }
    }

    return dm;
  }

  return {
    start: appContext.start,
    shutdown: appContext.shutdown,
    isShuttingDown: appContext.isShuttingDown,
    register,
    machines,
    pool,
  };
}

// ─── Convenience ────────────────────────────────────────────────────────────

export interface PgNativeWorkerStartOptions {
  pg: PgNativeWorkerConfig;
  worker: WorkerConfig;
  machines: Record<string, NativeMachineRegistration>;
  metrics?: WorkerMetrics;
  logger?: Logger;
}

export async function startPgNativeWorker(
  options: PgNativeWorkerStartOptions,
): Promise<PgNativeWorkerAppContext & WorkerHandle> {
  const { pg: pgConfig, worker, logger } = options;
  const metrics = options.metrics ?? (worker.adminPort != null ? createWorkerMetrics() : undefined);
  const appContext = createPgNativeWorkerContext(pgConfig, { metrics, logger });

  // Register all machines
  for (const [_key, registration] of Object.entries(options.machines)) {
    appContext.register(registration);
  }

  // Admin server
  let adminServer: import("node:http").Server | undefined;
  if (metrics && worker.adminPort != null) {
    adminServer = createAdminServer({
      metricsHandler: metrics.metricsHandler,
      isReady: () => !appContext.isShuttingDown(),
    });
    adminServer.listen(worker.adminPort);
  }

  const servers: import("node:http").Server[] = [];
  if (adminServer) servers.push(adminServer);

  await appContext.start({
    servers,
    timeoutMs: worker.shutdownTimeoutMs,
  });

  return {
    ...appContext,
    shutdown: () => appContext.shutdown("programmatic"),
    adminServer,
  };
}
