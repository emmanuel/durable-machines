import { DBOS } from "@dbos-inc/dbos-sdk";
import { initialTransition, transition } from "xstate";
import type { AnyStateMachine, AnyMachineSnapshot, AnyEventObject } from "xstate";
import type { DurableMachineOptions, ChannelAdapter, PromptConfig, TransitionRecord } from "../types.js";
import { DurableMachineError } from "../types.js";
import { isDurableState } from "../durable-state.js";
import { getPromptConfig } from "../prompt.js";
import { collectAndResolveEffects } from "../effect-collector.js";
import type { ResolvedEffect } from "../effects.js";
import {
  getActiveInvocation,
  extractActorImplementations,
  getSortedAfterDelays,
  buildAfterEvent,
  isReentryDelay,
  resolveTransientTransitions,
  serializeSnapshot,
  stateValueEquals,
} from "../xstate-utils.js";

const DEFAULT_MAX_WAIT_SECONDS = 86400; // 24 hours

/**
 * Creates a DBOS workflow function that drives an XState machine
 * through its states using durable execution primitives.
 *
 * The returned function is suitable for `DBOS.registerWorkflow()`.
 */
export function createMachineLoop(
  machine: AnyStateMachine,
  options: DurableMachineOptions,
) {
  const actorImpls = extractActorImplementations(machine);
  const channels: ChannelAdapter[] = options.channels ?? [];
  const enableTransitionStream = options.enableTransitionStream ?? false;
  const effectHandlers = options.effectHandlers;
  const effectRetryPolicy = options.effectRetryPolicy;

  // Register effect child workflow if handlers are provided
  let effectWorkflow: ((...args: any[]) => Promise<any>) | null = null;

  if (effectHandlers) {
    effectWorkflow = DBOS.registerWorkflow(
      async (effects: ResolvedEffect[]) => {
        for (let i = 0; i < effects.length; i++) {
          const effect = effects[i];
          const handler = effectHandlers.handlers.get(effect.type);
          if (!handler) continue;
          await DBOS.runStep(
            () => handler(effect),
            {
              name: `${effect.type}:${i}`,
              retriesAllowed: true,
              ...effectRetryPolicy,
            },
          );
        }
      },
      { name: `xstate:${machine.id}:effects` },
    );
  }

  return async function machineLoop(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const [initialSnapshot] = initialTransition(machine, input);
    let snapshot: AnyMachineSnapshot = initialSnapshot;

    await DBOS.setEvent("xstate.state", serializeSnapshot(snapshot));

    // Transition history (opt-in)
    const transitions: TransitionRecord[] = [];
    if (enableTransitionStream) {
      const initTs = await DBOS.now();
      transitions.push({ from: null, to: snapshot.value, ts: initTs });
      await DBOS.setEvent("xstate.transitions", transitions);
    }

    // Track which after delays have already fired in the current state.
    // Reset when the state value changes.
    let firedDelays = new Set<number>();
    let prevStateValue = snapshot.value;

    // Helper: persist state + transitions at boundary points
    async function persistSnapshot() {
      await DBOS.setEvent("xstate.state", serializeSnapshot(snapshot));
      if (enableTransitionStream) {
        await DBOS.setEvent("xstate.transitions", transitions);
      }
    }

    // Helper: record a transition in-memory (flushed at boundaries)
    async function recordTransition(from: import("xstate").StateValue, to: import("xstate").StateValue) {
      if (enableTransitionStream) {
        const ts = await DBOS.now();
        transitions.push({ from, to, ts });
      }
    }

    // Helper: dispatch effects as a child workflow
    async function dispatchEffects(
      prevSnap: AnyMachineSnapshot,
      nextSnap: AnyMachineSnapshot,
      event: AnyEventObject,
    ): Promise<void> {
      if (!effectWorkflow) return;

      const { effects } = collectAndResolveEffects(machine, prevSnap, nextSnap, event);
      if (effects.length === 0) return;

      // Start child workflow — parent does NOT await getResult()
      await DBOS.startWorkflow(effectWorkflow, {
        workflowID: `${DBOS.workflowID}:effects:${JSON.stringify(nextSnap.value)}`,
      })(effects);
    }

    // Dispatch effects for initial state entry
    {
      const emptyPrev = { _nodes: [] } as unknown as AnyMachineSnapshot;
      await dispatchEffects(emptyPrev, snapshot, { type: "xstate.init" } as AnyEventObject);
    }

    while (snapshot.status !== "done") {
      // 1. Resolve transient transitions (always/eventless)
      snapshot = resolveTransientTransitions(machine, snapshot);
      if (snapshot.status === "done") break;

      // Track transient state changes (accumulated in-memory, flushed at boundary)
      if (!stateValueEquals(snapshot.value, prevStateValue)) {
        await recordTransition(prevStateValue, snapshot.value);
        firedDelays = new Set<number>();
        prevStateValue = snapshot.value;
      }

      // 2. Determine what the current state needs
      const invocation = getActiveInvocation(machine, snapshot);

      if (invocation) {
        // Persist before invocation (crash recovery needs pre-invocation state)
        await persistSnapshot();
        const preInvokeSnapshot = snapshot;
        snapshot = await executeInvocation(machine, snapshot, invocation, actorImpls, options);
        // Persist after invocation returns
        if (!stateValueEquals(snapshot.value, prevStateValue)) {
          await recordTransition(prevStateValue, snapshot.value);
          await dispatchEffects(preInvokeSnapshot, snapshot, { type: `xstate.done.actor.${invocation.id}` } as AnyEventObject);
          firedDelays = new Set<number>();
          prevStateValue = snapshot.value;
        }
        await persistSnapshot();
      } else if (isDurableState(machine, snapshot)) {
        // Send prompt before waiting (if channels configured and state has a prompt)
        const promptConfig = getSnapshotPromptConfig(snapshot);
        let promptHandles: unknown[] | null = null;

        if (promptConfig && channels.length > 0) {
          promptHandles = await DBOS.runStep(
            async () => {
              const handles: unknown[] = [];
              for (const ch of channels) {
                const { handle } = await ch.sendPrompt({
                  workflowId: DBOS.workflowID!,
                  stateValue: snapshot.value,
                  prompt: promptConfig,
                  context: snapshot.context as Record<string, unknown>,
                });
                handles.push(handle);
              }
              return handles;
            },
            { name: `prompt:${JSON.stringify(snapshot.value)}` },
          );
        }

        // Persist before recv (durable wait boundary — observers read state while parked)
        await persistSnapshot();

        const prevValue = snapshot.value;
        const result = await waitForEventOrTimeout(machine, snapshot, firedDelays, options);
        if (result.firedDelay !== null && isReentryDelay(machine, snapshot, result.firedDelay)) {
          firedDelays = new Set<number>();
        } else if (result.firedDelay !== null) {
          firedDelays.add(result.firedDelay);
        }
        snapshot = result.snapshot;

        // Resolve prompt after transition (if state changed and prompt was sent)
        if (promptHandles && !stateValueEquals(prevValue, snapshot.value)) {
          await DBOS.runStep(
            async () => {
              for (let i = 0; i < channels.length; i++) {
                await channels[i].resolvePrompt?.({
                  handle: promptHandles[i],
                  event: result.firedDelay !== null
                    ? buildAfterEvent(machine, snapshot, result.firedDelay)
                    : { type: "xstate.resolved" },
                  newStateValue: snapshot.value,
                });
              }
            },
            { name: `resolve-prompt:${JSON.stringify(prevValue)}` },
          );
        }

        // Dispatch effects on state change after durable wait
        if (!stateValueEquals(prevValue, snapshot.value)) {
          const prevSnap = machine.resolveState({ value: prevValue, context: snapshot.context });
          const waitEvent = result.firedDelay !== null
            ? buildAfterEvent(machine, prevSnap, result.firedDelay) as AnyEventObject
            : { type: "xstate.resolved" } as AnyEventObject;
          await dispatchEffects(prevSnap, snapshot, waitEvent);
        }
      } else {
        throw new DurableMachineError(
          `State "${JSON.stringify(snapshot.value)}" is not a durable state, ` +
            `has no invocation, and has no transient transition. ` +
            `This should have been caught by validation.`,
        );
      }

      // Track state changes after a step (accumulated in-memory)
      if (!stateValueEquals(snapshot.value, prevStateValue)) {
        await recordTransition(prevStateValue, snapshot.value);
        firedDelays = new Set<number>();
        prevStateValue = snapshot.value;
      }
    }

    // Persist at loop exit (final state)
    await persistSnapshot();

    return snapshot.context as Record<string, unknown>;
  };
}

/**
 * Executes a fromPromise invocation as a DBOS step and transitions
 * the machine based on the result.
 */
async function executeInvocation(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  invocation: { id: string; src: string; input: unknown },
  actorImpls: Map<string, any>,
  options: DurableMachineOptions,
): Promise<AnyMachineSnapshot> {
  const impl = actorImpls.get(invocation.src);
  if (!impl) {
    throw new DurableMachineError(
      `No actor implementation found for "${invocation.src}". ` +
        `Ensure it is registered in setup({ actors: { ... } }).`,
    );
  }

  // The actor implementation from setup() is an AnyActorLogic object.
  // For fromPromise actors, we need to call the creator function.
  // The creator is stored as impl itself (the logic object).
  // We extract the promise creator from the logic's config.
  const creator = resolveActorCreator(impl);

  try {
    const output = await DBOS.runStep(
      () => creator({ input: invocation.input }),
      {
        name: `invoke:${invocation.src}`,
        ...options.stepRetryPolicy,
      },
    );

    const [next] = transition(machine, snapshot, {
      type: `xstate.done.actor.${invocation.id}`,
      output,
    } as AnyEventObject);
    return next;
  } catch (error) {
    const [next] = transition(machine, snapshot, {
      type: `xstate.error.actor.${invocation.id}`,
      error,
    } as AnyEventObject);
    return next;
  }
}

interface WaitResult {
  snapshot: AnyMachineSnapshot;
  /** The delay (ms) that fired, or null if an external event arrived or no timeout. */
  firedDelay: number | null;
}

/**
 * Waits for an external event or timeout in a durable state.
 *
 * Uses DBOS.recv() with the shortest unfired `after` delay as timeout,
 * implementing the race between external events and delayed transitions.
 *
 * When a state has multiple `after` delays (e.g. 5s reminder + 30s timeout),
 * `firedDelays` tracks which have already fired so the next iteration uses
 * the correct remaining delay.
 */
async function waitForEventOrTimeout(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  firedDelays: Set<number>,
  options: DurableMachineOptions,
): Promise<WaitResult> {
  const allDelays = getSortedAfterDelays(machine, snapshot);
  const delays = allDelays.filter((d) => !firedDelays.has(d));
  const hasAfter = delays.length > 0;

  // For remaining delays, subtract the largest already-fired delay
  // to compute the effective remaining wait time
  const maxFired = firedDelays.size > 0 ? Math.max(...firedDelays) : 0;
  const effectiveDelayMs = hasAfter
    ? Math.max(0, delays[0] - maxFired)
    : 0;

  const timeoutSec = hasAfter
    ? Math.max(1, Math.ceil(effectiveDelayMs / 1000))
    : (options.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS);

  // Write wake-up time for KEDA observability
  if (hasAfter) {
    const now = await DBOS.now();
    const wakeAt = now + effectiveDelayMs;
    await DBOS.setEvent("xstate.wakeAt", wakeAt);
  }

  const event = await DBOS.recv<AnyEventObject>("xstate.event", timeoutSec);

  // Clear wake-up time only when an external event arrived.
  // When the timeout fires, the next iteration will either set a new wakeAt
  // (overwriting this one) or the machine will end.
  if (hasAfter && event !== null) {
    await DBOS.setEvent("xstate.wakeAt", null);
  }

  if (event !== null) {
    // External event arrived before timeout
    const [next] = transition(machine, snapshot, event);
    return { snapshot: next, firedDelay: null };
  }

  if (hasAfter) {
    // Timeout expired — fire the next after event
    const afterEvent = buildAfterEvent(machine, snapshot, delays[0]);
    const [next] = transition(machine, snapshot, afterEvent as AnyEventObject);
    return { snapshot: next, firedDelay: delays[0] };
  }

  // No event, no timeout — return same snapshot (loop re-enters)
  return { snapshot, firedDelay: null };
}

/**
 * Resolves the callable creator function from an actor logic implementation.
 *
 * XState v5 `fromPromise()` returns an actor logic object where `config`
 * is the async creator function directly (not nested under `config.creator`).
 */
function resolveActorCreator(impl: any): (params: { input: unknown }) => Promise<unknown> {
  // fromPromise: impl.config IS the async creator function
  if (typeof impl?.config === "function") {
    return impl.config;
  }

  // If the impl itself is callable
  if (typeof impl === "function") {
    return impl;
  }

  throw new DurableMachineError(
    `Cannot resolve actor creator. The actor implementation must be created ` +
      `with fromPromise(). Got: ${typeof impl}`,
  );
}

/**
 * Extracts the prompt config from the active state nodes in a snapshot.
 */
function getSnapshotPromptConfig(
  snapshot: AnyMachineSnapshot,
): PromptConfig | null {
  for (const node of snapshot._nodes) {
    const config = getPromptConfig(node.meta);
    if (config) return config;
  }
  return null;
}
