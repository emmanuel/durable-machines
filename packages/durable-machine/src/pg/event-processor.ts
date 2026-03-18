import { initialTransition, transition } from "xstate";
import type {
  AnyStateMachine,
  AnyMachineSnapshot,
  AnyEventObject,
  StateValue,
} from "xstate";
import type { DurableMachineOptions } from "../types.js";
import { isDurableState } from "../durable-state.js";
import { handlePromptEntry, handlePromptExit } from "./prompt-lifecycle.js";
import { collectAndResolveEffects, extractEmittedEffects } from "../effect-collector.js";
import {
  getActiveInvocation,
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

  // Resolve transient transitions
  const [snapshot, transientActions] = resolveTransientTransitions(machine, initialSnapshot);
  const startupActions = [...initialActions, ...transientActions];

  // Check if initial state has an active invocation → park and queue
  const invocation = snapshot.status !== "done" ? getActiveInvocation(machine, snapshot) : null;

  // Compute wake_at + wake_event from after delays (only if not parking for invoke)
  const delays = invocation ? [] : getSortedAfterDelays(machine, snapshot);
  const wakeAt = delays.length > 0 ? now + delays[0] : null;
  const wakeEvent = wakeAt != null ? buildAfterEvent(machine, snapshot, delays[0]) : null;

  const status = snapshot.status === "done" ? "done" : "running";

  // Wrap creation + effect insert + invoke queue in a single transaction
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
        await store.insertEffects({ client, instanceId, machineName: machine.id, stateValue: snapshot.value, effects, maxAttempts });
      }
    }

    // Queue invoke task if initial state has an invocation
    if (invocation) {
      const retryPolicy = options.stepRetryPolicy;
      const maxAttempts = retryPolicy?.maxAttempts ?? 3;
      await store.queueInvokeTask({
        client,
        instanceId,
        machineName: machine.id,
        invokeId: invocation.id,
        invokeSrc: invocation.src,
        invokeInput: invocation.input,
        stateValue: snapshot.value,
        maxAttempts,
      });
    }
  });

  if (status === "done") {
    await store.updateInstanceStatus(instanceId, "done");
  }

  // Transition log
  if (enableAnalytics) {
    await store.appendTransition(instanceId, null, snapshot.value, null, now, snapshot.context as Record<string, unknown>, tenantId);
  }

  // Prompt lifecycle: send prompt if in durable state (and not parked for invoke)
  if (!invocation && status === "running" && isDurableState(machine, snapshot)) {
    await handlePromptEntry(store, instanceId, snapshot, channels);
  }
}

// ─── Finalization Helper ────────────────────────────────────────────────────

/**
 * Shared finalization logic: persist final state + cursor, append transition
 * log, handle prompt exit/entry, enqueue effects, and queue invoke tasks.
 *
 * If the new state has an active invocation, the invoke task is queued in the
 * same transaction. If actions include `xstate.stopChild`, the corresponding
 * invoke task is cancelled.
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

  // Check if new state has an active invocation
  const invocation = current.status !== "done" ? getActiveInvocation(machine, current) : null;

  // Compute wakeAt + wakeEvent (skip if parking for invoke)
  const nextDelays = invocation ? [] : getSortedAfterDelays(machine, current);
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

  // Handle xstate.stopChild actions → cancel invoke tasks
  for (const action of emittedActions) {
    if (action.type === "xstate.stopChild") {
      const invokeId = action.params?.id;
      if (invokeId) {
        await store.cancelInvokeTask(client, instanceId, invokeId);
      }
    }
  }

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

  // Queue invoke task if new state has an invocation
  if (invocation) {
    const retryPolicy = options.stepRetryPolicy;
    const maxAttempts = retryPolicy?.maxAttempts ?? 3;
    await store.queueInvokeTask({
      client,
      instanceId,
      machineName: machine.id,
      invokeId: invocation.id,
      invokeSrc: invocation.src,
      invokeInput: invocation.input,
      stateValue: current.value,
      maxAttempts,
    });
  }

  // Prompt lifecycle, effects
  const hasEmittedEffects = emittedActions.length > 0 && options.effectHandlers;
  if (stateChanged || hasEmittedEffects) {
    if (stateChanged) {
      await handlePromptExit(store, instanceId, prevStateValue, current, channels, event);
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
        await store.insertEffects({ client, instanceId, machineName: machine.id, stateValue: current.value, effects, maxAttempts });
      }
    }

    // Only send prompt if not parked for invoke
    if (!invocation && stateChanged && status === "running" && isDurableState(machine, current)) {
      await handlePromptEntry(store, instanceId, current, channels);
    }
  }
}

// ─── Batch Event Drain ───────────────────────────────────────────────────────

const BATCH_SIZE = 50;

/**
 * Drains up to `limit` events for an instance in a single transaction.
 * Returns the number of events processed (0 if none available or row locked).
 *
 * Invoke-aware event loop: when the current state has an active invocation,
 * only `xstate.done.actor.{id}` / `xstate.error.actor.{id}` events are
 * processed. All other events are skipped (cursor does NOT advance) — they
 * remain in event_log for processing after the invoke completes.
 */
export async function processBatchFromLog(
  deps: EventProcessorOptions,
  instanceId: string,
  limit = BATCH_SIZE,
): Promise<number> {
  const { store, machine } = deps;

  let processedCount = 0;

  await store.withTransaction(async (client) => {
    const result = await store.lockAndPeekEvents(client, instanceId, limit);
    if (!result || result.row.status !== "running" || result.events.length === 0) {
      return;
    }

    const { row, events } = result;

    // Set tenant GUC so all INSERTs in this transaction use the correct tenant_id DEFAULT
    await client.query({
      text: `SELECT set_config('app.tenant_id', $1, true)`,
      values: [row.tenantId],
    });

    const prevSnapshot = machine.resolveState({
      value: row.stateValue,
      context: row.context,
    });
    const prevStateValue = prevSnapshot.value;
    let current = prevSnapshot;
    let firedDelays: Array<string | number> = row.firedDelays;
    let lastEvent: AnyEventObject = events[0].payload as AnyEventObject;
    let lastEventSeq = 0;
    const batchActions: any[] = [];

    for (const evt of events) {
      const event = evt.payload as AnyEventObject;

      // Invoke-aware skipping: if current state has an active invocation,
      // only process the matching done/error events
      const invocation = getActiveInvocation(machine, current);
      if (invocation) {
        const doneType = `xstate.done.actor.${invocation.id}`;
        const errorType = `xstate.error.actor.${invocation.id}`;
        if (event.type !== doneType && event.type !== errorType) {
          // Skip this event — don't advance cursor past it
          continue;
        }
      }

      const [nextState, transitionActions] = transition(machine, current, event);
      const [resolved, transientActions] = resolveTransientTransitions(machine, nextState);

      batchActions.push(...transitionActions, ...transientActions);

      // Compute firedDelays for after events
      firedDelays = computeFiredDelays(machine, current, event, firedDelays);

      current = resolved;
      lastEvent = event;
      lastEventSeq = evt.seq;
      processedCount++;

      // If we landed in an invoke state, stop the batch here — finalize
      // will queue the invoke task
      if (current.status !== "done" && getActiveInvocation(machine, current)) {
        break;
      }
    }

    if (processedCount > 0) {
      await finalize(
        deps, client, instanceId,
        prevSnapshot, prevStateValue,
        current, lastEvent, lastEventSeq, firedDelays,
        batchActions,
      );
      deps.instruments?.batchSize.record(processedCount);
    }
  });

  return processedCount;
}
