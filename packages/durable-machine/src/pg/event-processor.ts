import { initialTransition, transition } from "xstate";
import type {
  AnyStateMachine,
  AnyMachineSnapshot,
  AnyEventObject,
  StateValue,
} from "xstate";
import type { DurableMachineOptions } from "../types.js";
import { DurableMachineError } from "../types.js";
import { isDurableState } from "../durable-state.js";
import { handlePromptEntry, handlePromptExit } from "./prompt-lifecycle.js";
import { collectAndResolveEffects, extractEmittedEffects } from "../effect-collector.js";
import {
  getActiveInvocation,
  extractActorImplementations,
  getSortedAfterDelays,
  buildAfterEvent,
  isReentryDelay,
  resolveTransientTransitions,
  stateValueEquals,
} from "../xstate-utils.js";
import type { PgStore } from "./store.js";
import type { StoreInstruments } from "./store-metrics.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EventProcessorOptions {
  store: PgStore;
  machine: AnyStateMachine;
  options: DurableMachineOptions;
  enableAnalytics?: boolean;
  instruments?: StoreInstruments;
}


// ─── Actor Execution Helper ─────────────────────────────────────────────────

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

// ─── Fired Delays Helper ────────────────────────────────────────────────────

function computeFiredDelays(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  event: AnyEventObject,
  currentFiredDelays: Array<string | number>,
): Array<string | number> {
  if (!event.type.startsWith("xstate.after.")) return [];
  const allDelays = getSortedAfterDelays(machine, snapshot);
  const unfired = allDelays.filter((d) => !currentFiredDelays.includes(d));
  const firedDelay = unfired[0];
  if (firedDelay === undefined) return currentFiredDelays;
  return isReentryDelay(machine, snapshot, firedDelay)
    ? []
    : [...currentFiredDelays, firedDelay];
}

// ─── Core: Execute Invocations Inline ───────────────────────────────────────

async function executeInvocationsInline(
  deps: EventProcessorOptions,
  instanceId: string,
  snapshot: AnyMachineSnapshot,
  tenantId?: string,
): Promise<[AnyMachineSnapshot, any[]]> {
  const { store, machine } = deps;
  const actorImpls = extractActorImplementations(machine);
  let current = snapshot;
  const allActions: any[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Resolve transient transitions
    const [resolved, transientActions] = resolveTransientTransitions(machine, current);
    current = resolved;
    allActions.push(...transientActions);
    if (current.status === "done") break;

    const invocation = getActiveInvocation(machine, current);
    if (!invocation) break;

    const stepKey = `invoke:${invocation.src}`;

    // Check for cached result (crash recovery)
    const cached = await store.getInvokeResult(instanceId, stepKey);
    let output: unknown;
    let error: unknown;

    if (cached) {
      output = cached.output;
      error = cached.error;
    } else {
      const impl = actorImpls.get(invocation.src);
      if (!impl) {
        throw new DurableMachineError(
          `No actor implementation found for "${invocation.src}". ` +
            `Ensure it is registered in setup({ actors: { ... } }).`,
          "INTERNAL",
        );
      }

      const creator = resolveActorCreator(impl);
      const startedAt = Date.now();
      const invokeTimeoutMs = deps.options.invokeTimeoutMs ?? 30_000;

      const result = await Promise.race([
        creator({ input: invocation.input }).then(
          (out) => ({ output: out, error: undefined }),
          (err) => ({ output: undefined, error: err }),
        ),
        new Promise<{ output: undefined; error: Error }>((resolve) =>
          setTimeout(
            () => resolve({ output: undefined, error: new Error(`Invocation "${invocation.src}" timed out after ${invokeTimeoutMs}ms`) }),
            invokeTimeoutMs,
          ),
        ),
      ]);

      output = result.output;
      error = result.error;

      await store.recordInvokeResult({
        instanceId,
        stepKey,
        output,
        error,
        startedAt,
        completedAt: Date.now(),
        tenantId,
      });
    }

    // Transition based on result
    if (error != null) {
      const [next, actions] = transition(machine, current, {
        type: `xstate.error.actor.${invocation.id}`,
        error,
      } as AnyEventObject);
      current = next;
      allActions.push(...actions);
    } else {
      const [next, actions] = transition(machine, current, {
        type: `xstate.done.actor.${invocation.id}`,
        output,
      } as AnyEventObject);
      current = next;
      allActions.push(...actions);
    }
  }

  return [current, allActions];
}

// ─── Process Startup ────────────────────────────────────────────────────────

export async function processStartup(
  deps: EventProcessorOptions,
  instanceId: string,
  input: Record<string, unknown>,
  tenantId?: string,
): Promise<void> {
  const { store, machine, options, enableAnalytics } = deps;
  const channels = options.channels ?? [];
  const now = Date.now();

  const [initialSnapshot, initialActions] = initialTransition(machine, input);
  const [snapshot, invokeActions] = await executeInvocationsInline(
    deps,
    instanceId,
    initialSnapshot,
    tenantId,
  );
  const startupActions = [...initialActions, ...invokeActions];

  // Compute wake_at + wake_event from after delays
  const delays = getSortedAfterDelays(machine, snapshot);
  const wakeAt = delays.length > 0 ? now + delays[0] : null;
  const wakeEvent = wakeAt != null ? buildAfterEvent(machine, snapshot, delays[0]) : null;

  const status = snapshot.status === "done" ? "done" : "running";

  // Wrap creation + effect insert in a single transaction
  await store.withTransaction(async (client) => {
    if (tenantId) {
      await client.query({
        text: `SELECT set_config('app.tenant_id', $1, true)`,
        values: [tenantId],
      });
    }
    await store.createInstance({
      id: instanceId,
      machineName: machine.id,
      stateValue: snapshot.value,
      context: snapshot.context as Record<string, unknown>,
      input,
      wakeAt,
      firedDelays: [],
      queryable: client,
      wakeEvent,
    });

    if (options.effectHandlers) {
      const emptyPrev = { _nodes: [] } as unknown as AnyMachineSnapshot;
      const { effects: metaEffects } = collectAndResolveEffects(
        machine, emptyPrev, snapshot, { type: "xstate.init" } as AnyEventObject,
      );
      const emittedEffects = extractEmittedEffects(startupActions);
      const effects = [...metaEffects, ...emittedEffects];
      if (effects.length > 0) {
        const retryPolicy = options.effectRetryPolicy;
        const maxAttempts = retryPolicy?.maxAttempts ?? 3;
        await store.insertEffects({ client, instanceId, stateValue: snapshot.value, effects, maxAttempts });
      }
    }
  });

  if (status === "done") {
    await store.updateInstanceStatus(instanceId, "done");
  }

  // Transition log
  if (enableAnalytics) {
    await store.appendTransition(instanceId, null, snapshot.value, null, now, snapshot.context as Record<string, unknown>, tenantId);
  }

  // Prompt lifecycle: send prompt if in durable state
  if (status === "running" && isDurableState(machine, snapshot)) {
    await handlePromptEntry(store,instanceId, snapshot, channels);
  }

}

// ─── Finalization Helper ────────────────────────────────────────────────────

/**
 * Shared finalization logic: persist final state + cursor, append transition
 * log, handle prompt exit/entry, and enqueue effects.  Used by both the fast
 * path (no invocation) and the post-invocation Txn 2.
 */
async function finalize(
  deps: EventProcessorOptions,
  client: import("pg").PoolClient,
  instanceId: string,
  prevSnapshot: AnyMachineSnapshot,
  prevStateValue: StateValue,
  current: AnyMachineSnapshot,
  event: AnyEventObject,
  eventSeq: number,
  firedDelays: Array<string | number>,
  emittedActions: any[] = [],
): Promise<void> {
  const { store, machine, options, enableAnalytics } = deps;
  const channels = options.channels ?? [];

  // Compute wakeAt + wakeEvent
  const nextDelays = getSortedAfterDelays(machine, current);
  const nextUnfired = nextDelays.filter((d) => !firedDelays.includes(d));
  let wakeAt: number | null = null;
  let wakeEvent: AnyEventObject | null = null;
  if (nextUnfired.length > 0) {
    if (firedDelays.length === 0) {
      wakeAt = Date.now() + nextUnfired[0];
    } else {
      const maxFired = Math.max(
        ...(firedDelays.filter((d) => typeof d === "number") as number[]),
      );
      wakeAt = Date.now() + Math.max(0, nextUnfired[0] - maxFired);
    }
    wakeEvent = buildAfterEvent(machine, current, nextUnfired[0]);
  }

  const status = current.status === "done" ? "done" : "running";
  const stateChanged = !stateValueEquals(prevStateValue, current.value);

  // Atomic: state change + cursor advance (+ transition log if applicable)
  if (enableAnalytics && stateChanged) {
    await store.finalizeWithTransition({
      client, instanceId,
      stateValue: current.value, context: current.context as Record<string, unknown>,
      wakeAt, wakeEvent, firedDelays, status, eventCursor: eventSeq,
      fromState: prevStateValue, toState: current.value, event: event.type, ts: Date.now(),
      contextSnapshot: current.context as Record<string, unknown>,
    });
  } else {
    await store.finalizeInstance({
      client, instanceId,
      stateValue: current.value, context: current.context as Record<string, unknown>,
      wakeAt, wakeEvent, firedDelays, status, eventCursor: eventSeq,
    });
  }

  // Prompt lifecycle, effects
  const hasEmittedEffects = emittedActions.length > 0 && options.effectHandlers;
  if (stateChanged || hasEmittedEffects) {
    if (stateChanged) {
      await handlePromptExit(store,instanceId, prevStateValue, current, channels, event);
    }

    if (options.effectHandlers) {
      const { effects: metaEffects } = stateChanged
        ? collectAndResolveEffects(machine, prevSnapshot, current, event)
        : { effects: [] };
      const emittedEffects = extractEmittedEffects(emittedActions);
      const effects = [...metaEffects, ...emittedEffects];
      if (effects.length > 0) {
        const retryPolicy = options.effectRetryPolicy;
        const maxAttempts = retryPolicy?.maxAttempts ?? 3;
        await store.insertEffects({ client, instanceId, stateValue: current.value, effects, maxAttempts });
      }
    }

    if (stateChanged && status === "running" && isDurableState(machine, current)) {
      await handlePromptEntry(store,instanceId, current, channels);
    }
  }
}

// ─── Two-Phase Invocation ────────────────────────────────────────────────────

/**
 * Executes invocations outside any lock, then re-locks and finalizes.
 * Returns `true` if the invocation was finalized (or the instance was cancelled).
 */
async function executeAndFinalizeInvocation(
  deps: EventProcessorOptions,
  instanceId: string,
  invocationSnapshot: AnyMachineSnapshot,
  prevSnapshot: AnyMachineSnapshot,
  prevStateValue: StateValue,
  event: AnyEventObject,
  eventSeq: number,
  firedDelays: Array<string | number>,
  preActions: any[] = [],
  tenantId?: string,
): Promise<boolean> {
  const [postInvoke, invokeActions] = await executeInvocationsInline(deps, instanceId, invocationSnapshot, tenantId);
  const allActions = [...preActions, ...invokeActions];

  let processed = false;
  await deps.store.withTransaction(async (client) => {
    const row = await deps.store.lockAndGetInstance(client, instanceId);
    if (!row || row.status === "cancelled") {
      processed = row?.status === "cancelled";
      return;
    }
    await client.query({
      text: `SELECT set_config('app.tenant_id', $1, true)`,
      values: [row.tenantId],
    });
    await finalize(
      deps, client, instanceId,
      prevSnapshot, prevStateValue,
      postInvoke, event, eventSeq, firedDelays,
      allActions,
    );
    processed = true;
  });

  return processed;
}

// ─── Batch Event Drain ───────────────────────────────────────────────────────

const BATCH_SIZE = 50;

/**
 * Drains up to `limit` events for an instance in a single transaction.
 * Returns the number of events processed (0 if none available or row locked).
 *
 * When an invocation is encountered mid-batch, processing stops: the invoking
 * state is persisted (no cursor advance), the invocation runs outside the lock,
 * and a second transaction finalizes with cursor at the invocation event.
 */
export async function processBatchFromLog(
  deps: EventProcessorOptions,
  instanceId: string,
  limit = BATCH_SIZE,
): Promise<number> {
  const { store, machine } = deps;

  let invocationSnapshot: AnyMachineSnapshot | null = null;
  let prevSnapshot: AnyMachineSnapshot;
  let prevStateValue: StateValue;
  let tenantId: string | undefined;
  let lastEvent: AnyEventObject;
  let lastEventSeq = 0;
  let firedDelays: Array<string | number> = [];
  let processedCount = 0;
  let batchActions: any[] = [];

  // Track state before invocation for mid-batch commit
  let preInvokeState: AnyMachineSnapshot;
  let preInvokeEvent: AnyEventObject;
  let preInvokeSeq = 0;
  let preInvokeFiredDelays: Array<string | number>;
  let preInvokeActions: any[] = [];

  await store.withTransaction(async (client) => {
    const result = await store.lockAndPeekEvents(client, instanceId, limit);
    if (!result || result.row.status !== "running" || result.events.length === 0) {
      return;
    }

    const { row, events } = result;

    tenantId = row.tenantId;

    // Set tenant GUC so all INSERTs in this transaction use the correct tenant_id DEFAULT
    await client.query({
      text: `SELECT set_config('app.tenant_id', $1, true)`,
      values: [row.tenantId],
    });

    prevSnapshot = machine.resolveState({
      value: row.stateValue,
      context: row.context,
    });
    prevStateValue = prevSnapshot.value;
    let current = prevSnapshot;
    firedDelays = row.firedDelays;
    lastEvent = events[0].payload as AnyEventObject;

    preInvokeState = current;
    preInvokeEvent = lastEvent;
    preInvokeFiredDelays = firedDelays;

    for (const evt of events) {
      const event = evt.payload as AnyEventObject;
      const [nextState, transitionActions] = transition(machine, current, event);
      const [resolved, transientActions] = resolveTransientTransitions(machine, nextState);

      batchActions.push(...transitionActions, ...transientActions);

      // Compute firedDelays for after events
      firedDelays = computeFiredDelays(machine, current, event, firedDelays);

      // Check for invocation — stop batch here
      if (resolved.status !== "done" && getActiveInvocation(machine, resolved)) {
        invocationSnapshot = resolved;
        lastEvent = event;
        lastEventSeq = evt.seq;
        break;
      }

      current = resolved;
      lastEvent = event;
      lastEventSeq = evt.seq;
      processedCount++;

      // Track for mid-batch commit if invocation comes next
      preInvokeState = current;
      preInvokeEvent = event;
      preInvokeSeq = evt.seq;
      preInvokeFiredDelays = firedDelays;
      preInvokeActions = [...batchActions];
    }

    if (processedCount > 0 && !invocationSnapshot) {
      // All events processed without invocation — finalize
      await finalize(
        deps, client, instanceId,
        prevSnapshot, prevStateValue,
        current, lastEvent, lastEventSeq, firedDelays,
        batchActions,
      );
      deps.instruments?.batchSize.record(processedCount);
      return;
    }

    if (invocationSnapshot) {
      if (processedCount > 0) {
        // Commit pre-invocation events first: finalize state + advance cursor
        await finalize(
          deps, client, instanceId,
          prevSnapshot, prevStateValue,
          preInvokeState!, preInvokeEvent!, preInvokeSeq, preInvokeFiredDelays!,
          preInvokeActions,
        );
        // Update prevSnapshot/prevStateValue for the invocation finalize
        prevSnapshot = preInvokeState!;
        prevStateValue = preInvokeState!.value;
      } else {
        // First event triggered the invocation — persist invoking state only
        await store.updateInstanceSnapshot(
          client, instanceId,
          invocationSnapshot.value,
          invocationSnapshot.context as Record<string, unknown>,
        );
      }
    }
  });

  if (!invocationSnapshot) {
    return processedCount;
  }

  // Two-phase: execute outside lock, then re-lock and finalize
  // Pass only the actions from the invocation event (not pre-invoke actions already finalized)
  const invocationActions = batchActions.slice(preInvokeActions.length);
  if (await executeAndFinalizeInvocation(
    deps, instanceId, invocationSnapshot,
    prevSnapshot!, prevStateValue!,
    lastEvent!, lastEventSeq, firedDelays,
    invocationActions, tenantId,
  )) {
    processedCount++;
  }

  deps.instruments?.batchSize.record(processedCount);
  return processedCount;
}
