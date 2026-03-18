import type { AnyStateMachine, AnyEventObject } from "xstate";
import type { Logger } from "../types.js";
import { DurableMachineError } from "../types.js";
import type { EffectHandler, ResolvedEffect, EffectHandlerContext } from "../effects.js";
import type { PgStore } from "./store.js";
import type { TaskOutboxRow } from "./store-types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TaskExecutorDeps {
  store: PgStore;
  machines: ReadonlyMap<string, { machine: AnyStateMachine }>;
  effectHandlers: Map<string, EffectHandler>;
  dispatch: (instanceId: string, machineName: string) => void;
  logger: Logger;
  invokeTimeoutMs?: number;
}

export interface TaskExecutorMetrics {
  effectsExecutedTotal: { add(value: number, attrs: Record<string, string>): void };
  effectExecutionDuration: { record(value: number, attrs: Record<string, string>): void };
}

// ─── Actor Helpers ──────────────────────────────────────────────────────────

function resolveActorCreator(
  impl: any,
): (params: { input: unknown }) => Promise<unknown> {
  if (typeof impl?.config === "function") return impl.config;
  if (typeof impl === "function") return impl;
  throw new DurableMachineError(
    `Cannot resolve actor creator. The actor implementation must be created ` +
      `with fromPromise(). Got: ${typeof impl}`,
    "INTERNAL",
  );
}

function extractActorImplementations(
  machine: AnyStateMachine,
): Map<string, any> {
  const impls = new Map<string, any>();
  const actors = (machine as any).implementations?.actors;
  if (!actors || typeof actors !== "object") return impls;
  for (const [name, impl] of Object.entries(actors)) {
    impls.set(name, impl);
  }
  return impls;
}

// ─── Execute Task (router) ──────────────────────────────────────────────────

export async function executeTask(
  deps: TaskExecutorDeps,
  row: TaskOutboxRow,
  metrics?: TaskExecutorMetrics,
): Promise<void> {
  if (row.taskKind === "invoke") {
    await executeInvoke(deps, row);
  } else {
    await executeEffect(deps, row, metrics);
  }
}

// ─── Execute Invoke ─────────────────────────────────────────────────────────

async function executeInvoke(
  deps: TaskExecutorDeps,
  row: TaskOutboxRow,
): Promise<void> {
  const { store, machines, logger, invokeTimeoutMs = 30_000 } = deps;

  const idempotencyKey = `invoke:${row.id}`;

  // Step 1: Check if result event already exists (crash recovery dedup)
  const exists = await store.checkInvokeEventExists(row.instanceId, idempotencyKey);
  if (exists) {
    await store.markEffectCompleted(row.id);
    logger.debug({ taskId: row.id, invokeId: row.invokeId }, "invoke result already exists, skipping");
    deps.dispatch(row.instanceId, row.machineName!);
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

  const actorImpls = extractActorImplementations(dm.machine);
  const invokeSrc = row.invokeSrc;
  if (!invokeSrc) {
    await store.markEffectFailed(row.id, "Missing invoke_src on invoke task", null);
    return;
  }

  const impl = actorImpls.get(invokeSrc);
  if (!impl) {
    // No retry — this is a configuration error
    const errorEvent: AnyEventObject = {
      type: `xstate.error.actor.${row.invokeId}`,
      error: new DurableMachineError(
        `No actor implementation found for "${invokeSrc}". ` +
          `Ensure it is registered in setup({ actors: { ... } }).`,
        "INTERNAL",
      ),
    };
    await store.appendEventWithKey(
      row.instanceId,
      errorEvent,
      idempotencyKey,
      "event",
      "system:invoke",
    );
    await store.markEffectFailed(row.id, `No actor implementation for "${invokeSrc}"`, null);
    deps.dispatch(row.instanceId, machineName);
    return;
  }

  // Step 3: Execute actor with timeout
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

  // Step 4: Check if task was cancelled while we were executing
  const status = await store.checkTaskStatus(row.id);
  if (status === "cancelled") {
    logger.debug({ taskId: row.id, invokeId: row.invokeId }, "invoke task cancelled during execution");
    await store.markEffectCompleted(row.id);
    return;
  }

  // Step 5: Insert result event with idempotency key
  const resultEvent: AnyEventObject = error != null
    ? { type: `xstate.error.actor.${row.invokeId}`, error }
    : { type: `xstate.done.actor.${row.invokeId}`, output };

  await store.appendEventWithKey(
    row.instanceId,
    resultEvent,
    idempotencyKey,
    "event",
    "system:invoke",
  );

  // Step 6: Mark task completed
  await store.markEffectCompleted(row.id);

  // Step 7: Direct dispatch — bypass NOTIFY round-trip
  deps.dispatch(row.instanceId, machineName);
}

// ─── Execute Effect ─────────────────────────────────────────────────────────

function computeBackoff(attempt: number): number {
  const baseMs = 1000;
  const rate = 2;
  return baseMs * rate ** (attempt - 1);
}

async function executeEffect(
  deps: TaskExecutorDeps,
  row: TaskOutboxRow,
  metrics?: TaskExecutorMetrics,
): Promise<void> {
  const { store, effectHandlers, logger } = deps;

  const handler = effectHandlers.get(row.effectType);
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
