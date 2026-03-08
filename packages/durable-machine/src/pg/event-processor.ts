import { initialTransition, transition } from "xstate";
import type {
  AnyStateMachine,
  AnyMachineSnapshot,
  AnyEventObject,
} from "xstate";
import type {
  DurableMachineOptions,
  ChannelAdapter,
  PromptConfig,
} from "../types.js";
import { DurableMachineError } from "../types.js";
import { isDurableState } from "../durable-state.js";
import { getPromptConfig } from "../prompt.js";
import { collectAndResolveEffects } from "../effect-collector.js";
import {
  getActiveInvocation,
  extractActorImplementations,
  getSortedAfterDelays,
  isReentryDelay,
  resolveTransientTransitions,
  stateValueEquals,
} from "../xstate-utils.js";
import type { PgStore } from "./store.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EventProcessorOptions {
  store: PgStore;
  machine: AnyStateMachine;
  options: DurableMachineOptions;
  enableTransitionStream?: boolean;
}

// ─── Lock Retry Helper ──────────────────────────────────────────────────────

const withRetry = (
  fn: () => Promise<void>,
  maxAttempts = 3,
  baseMs = 50,
): Promise<void> => {
  const attempt = (n: number): Promise<void> =>
    fn().catch((err) =>
      (err as any).code === "55P03" && n < maxAttempts
        ? new Promise<void>((r) => setTimeout(r, baseMs * 2 ** n)).then(() =>
            attempt(n + 1),
          )
        : Promise.reject(err),
    );
  return attempt(0);
};

// ─── Actor Execution Helper ─────────────────────────────────────────────────

function resolveActorCreator(
  impl: any,
): (params: { input: unknown }) => Promise<unknown> {
  if (typeof impl?.config === "function") return impl.config;
  if (typeof impl === "function") return impl;
  throw new DurableMachineError(
    `Cannot resolve actor creator. The actor implementation must be created ` +
      `with fromPromise(). Got: ${typeof impl}`,
  );
}

// ─── Prompt Helpers ─────────────────────────────────────────────────────────

function getSnapshotPromptConfig(
  snapshot: AnyMachineSnapshot,
): PromptConfig | null {
  for (const node of snapshot._nodes) {
    const config = getPromptConfig(node.meta);
    if (config) return config;
  }
  return null;
}

// ─── Effects Helper ─────────────────────────────────────────────────────────

async function enqueueEffects(
  deps: EventProcessorOptions,
  client: import("pg").PoolClient,
  instanceId: string,
  prevSnapshot: AnyMachineSnapshot,
  nextSnapshot: AnyMachineSnapshot,
  event: AnyEventObject,
): Promise<void> {
  if (!deps.options.effectHandlers) return;

  const { effects } = collectAndResolveEffects(
    deps.machine, prevSnapshot, nextSnapshot, event,
  );
  if (effects.length === 0) return;

  const retryPolicy = deps.options.effectRetryPolicy;
  const maxAttempts = retryPolicy?.maxAttempts ?? 3;

  await deps.store.insertEffects(client, instanceId, nextSnapshot.value, effects, maxAttempts);
}

// ─── Core: Execute Invocations Inline ───────────────────────────────────────

async function executeInvocationsInline(
  deps: EventProcessorOptions,
  instanceId: string,
  snapshot: AnyMachineSnapshot,
): Promise<AnyMachineSnapshot> {
  const { store, machine } = deps;
  const actorImpls = extractActorImplementations(machine);
  let current = snapshot;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Resolve transient transitions
    current = resolveTransientTransitions(machine, current);
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
        );
      }

      const creator = resolveActorCreator(impl);
      const startedAt = Date.now();

      const result = await creator({ input: invocation.input }).then(
        (out) => ({ output: out, error: undefined }),
        (err) => ({ output: undefined, error: err }),
      );

      output = result.output;
      error = result.error;

      await store.recordInvokeResult(
        instanceId,
        stepKey,
        output,
        error,
        startedAt,
        Date.now(),
      );
    }

    // Transition based on result
    if (error != null) {
      const [next] = transition(machine, current, {
        type: `xstate.error.actor.${invocation.id}`,
        error,
      } as AnyEventObject);
      current = next;
    } else {
      const [next] = transition(machine, current, {
        type: `xstate.done.actor.${invocation.id}`,
        output,
      } as AnyEventObject);
      current = next;
    }
  }

  return current;
}

// ─── Prompt Lifecycle ───────────────────────────────────────────────────────

async function handlePromptEntry(
  deps: EventProcessorOptions,
  instanceId: string,
  snapshot: AnyMachineSnapshot,
  channels: ChannelAdapter[],
): Promise<void> {
  const promptConfig = getSnapshotPromptConfig(snapshot);
  if (!promptConfig || channels.length === 0) return;

  const stepKey = `prompt:${JSON.stringify(snapshot.value)}`;

  // Check for cached handles
  const cached = await deps.store.getInvokeResult(instanceId, stepKey);
  if (cached) return;

  const handles: unknown[] = [];
  for (const ch of channels) {
    const { handle } = await ch.sendPrompt({
      workflowId: instanceId,
      stateValue: snapshot.value,
      prompt: promptConfig,
      context: snapshot.context as Record<string, unknown>,
    });
    handles.push(handle);
  }

  await deps.store.recordInvokeResult(
    instanceId,
    stepKey,
    handles,
    undefined,
    Date.now(),
    Date.now(),
  );
}

async function handlePromptExit(
  deps: EventProcessorOptions,
  instanceId: string,
  prevStateValue: unknown,
  newSnapshot: AnyMachineSnapshot,
  channels: ChannelAdapter[],
  event: AnyEventObject,
): Promise<void> {
  if (channels.length === 0) return;

  const stepKey = `prompt:${JSON.stringify(prevStateValue)}`;
  const cached = await deps.store.getInvokeResult(instanceId, stepKey);
  if (!cached) return;

  const handles = cached.output as unknown[];

  const resolveKey = `resolve-prompt:${JSON.stringify(prevStateValue)}`;
  const resolved = await deps.store.getInvokeResult(instanceId, resolveKey);
  if (resolved) return;

  for (let i = 0; i < channels.length; i++) {
    await channels[i].resolvePrompt?.({
      handle: handles?.[i],
      event,
      newStateValue: newSnapshot.value,
    });
  }

  await deps.store.recordInvokeResult(
    instanceId,
    resolveKey,
    true,
    undefined,
    Date.now(),
    Date.now(),
  );
}

// ─── Process Startup ────────────────────────────────────────────────────────

export async function processStartup(
  deps: EventProcessorOptions,
  instanceId: string,
  input: Record<string, unknown>,
): Promise<void> {
  const { store, machine, options, enableTransitionStream } = deps;
  const channels = options.channels ?? [];
  const now = Date.now();

  const [initialSnapshot] = initialTransition(machine, input);
  let snapshot = await executeInvocationsInline(
    deps,
    instanceId,
    initialSnapshot,
  );

  // Compute wake_at from after delays
  const delays = getSortedAfterDelays(machine, snapshot);
  const wakeAt = delays.length > 0 ? now + delays[0] : null;

  const status = snapshot.status === "done" ? "done" : "running";

  // Wrap creation + effect insert in a single transaction
  const client = await getPool(store).connect();
  try {
    await client.query("BEGIN");

    await store.createInstance(
      instanceId,
      machine.id,
      snapshot.value,
      snapshot.context as Record<string, unknown>,
      input,
      wakeAt,
      [],
      client,
    );

    if (deps.options.effectHandlers) {
      const emptyPrev = { _nodes: [] } as unknown as AnyMachineSnapshot;
      await enqueueEffects(deps, client, instanceId, emptyPrev, snapshot, { type: "xstate.init" } as AnyEventObject);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (status === "done") {
    await store.updateInstance(instanceId, { status: "done" });
  }

  // Transition log
  if (enableTransitionStream) {
    await store.appendTransition(instanceId, null, snapshot.value, null, now);
  }

  // Prompt lifecycle: send prompt if in durable state
  if (status === "running" && isDurableState(machine, snapshot)) {
    await handlePromptEntry(deps, instanceId, snapshot, channels);
  }
}

// ─── Process Next From Log ──────────────────────────────────────────────────

export async function processNextFromLog(
  deps: EventProcessorOptions,
  instanceId: string,
): Promise<boolean> {
  const { store, machine, options, enableTransitionStream } = deps;
  const channels = options.channels ?? [];
  let processed = false;

  await withRetry(async () => {
    const client = await getPool(store).connect();
    try {
      await client.query("BEGIN");

      // Single roundtrip: lock instance + peek next unconsumed event
      const result = await store.lockAndPeekEvent(client, instanceId);
      if (!result || result.row.status !== "running" || !result.nextEvent) {
        await client.query("COMMIT");
        return;
      }

      const { row, nextEvent } = result;
      const event = nextEvent.payload as AnyEventObject;
      const snapshot = machine.resolveState({
        value: row.stateValue,
        context: row.context,
      });
      const prevStateValue = snapshot.value;

      // Transition + invocations
      const [nextState] = transition(machine, snapshot, event);
      let current = await executeInvocationsInline(deps, instanceId, nextState);

      // Compute firedDelays — timeout-aware
      let newFiredDelays: Array<string | number>;
      if (event.type.startsWith("xstate.after.")) {
        const allDelays = getSortedAfterDelays(machine, snapshot);
        const unfired = allDelays.filter(
          (d) => !(row.firedDelays as Array<string | number>).includes(d),
        );
        const firedDelay = unfired[0];
        newFiredDelays = firedDelay !== undefined && isReentryDelay(machine, snapshot, firedDelay)
          ? []
          : [...(row.firedDelays as Array<string | number>), ...(firedDelay !== undefined ? [firedDelay] : [])];
      } else {
        newFiredDelays = [];
      }

      // Compute wakeAt
      const nextDelays = getSortedAfterDelays(machine, current);
      const nextUnfired = nextDelays.filter((d) => !newFiredDelays.includes(d));
      let wakeAt: number | null = null;
      if (nextUnfired.length > 0) {
        if (newFiredDelays.length === 0) {
          wakeAt = Date.now() + nextUnfired[0];
        } else {
          const maxFired = Math.max(
            ...(newFiredDelays.filter((d) => typeof d === "number") as number[]),
          );
          wakeAt = Date.now() + Math.max(0, nextUnfired[0] - maxFired);
        }
      }

      const status = current.status === "done" ? "done" : "running";

      // Atomic: state change + cursor advance
      await store.updateInstance(
        instanceId,
        {
          stateValue: current.value,
          context: current.context as Record<string, unknown>,
          wakeAt,
          firedDelays: newFiredDelays,
          status,
          eventCursor: nextEvent.seq,
        },
        client,
      );

      // Transition log, prompt lifecycle, effects
      if (enableTransitionStream && !stateValueEquals(prevStateValue, current.value)) {
        await store.appendTransition(instanceId, prevStateValue, current.value, event.type, Date.now());
      }
      if (!stateValueEquals(prevStateValue, current.value)) {
        await handlePromptExit(deps, instanceId, prevStateValue, current, channels, event);
        await enqueueEffects(deps, client, instanceId, snapshot, current, event);
        if (status === "running" && isDurableState(machine, current)) {
          await handlePromptEntry(deps, instanceId, current, channels);
        }
      }

      await client.query("COMMIT");
      processed = true;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
  return processed;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Extract the pool from a store. The store is a closure-based object so we
 * need a way to get the pool for transaction clients. We attach it during
 * createStore or the caller passes it via the deps.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPool(store: PgStore): any {
  return (store as any)._pool;
}
