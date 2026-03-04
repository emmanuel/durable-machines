import { DBOS } from "@dbos-inc/dbos-sdk";
import { initialTransition, transition } from "xstate";
import type { AnyStateMachine, AnyMachineSnapshot, AnyEventObject } from "xstate";
import type { DurableMachineOptions } from "./types.js";
import { DurableMachineError } from "./types.js";
import { isQuiescent } from "./quiescent.js";
import {
  getActiveInvocation,
  extractActorImplementations,
  getSortedAfterDelays,
  buildAfterEvent,
  resolveTransientTransitions,
  serializeSnapshot,
} from "./xstate-utils.js";

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

  return async function machineLoop(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const [initialSnapshot] = initialTransition(machine, input);
    let snapshot: AnyMachineSnapshot = initialSnapshot;

    await DBOS.setEvent("xstate.state", serializeSnapshot(snapshot));

    while (snapshot.status !== "done") {
      // 1. Resolve transient transitions (always/eventless)
      snapshot = resolveTransientTransitions(machine, snapshot);
      if (snapshot.status === "done") break;

      // 2. Determine what the current state needs
      const invocation = getActiveInvocation(machine, snapshot);

      if (invocation) {
        snapshot = await executeInvocation(machine, snapshot, invocation, actorImpls, options);
      } else if (isQuiescent(machine, snapshot)) {
        snapshot = await waitForEventOrTimeout(machine, snapshot, options);
      } else {
        throw new DurableMachineError(
          `State "${JSON.stringify(snapshot.value)}" is not quiescent, ` +
            `has no invocation, and has no transient transition. ` +
            `This should have been caught by validation.`,
        );
      }

      // 3. Publish updated state
      await DBOS.setEvent("xstate.state", serializeSnapshot(snapshot));
    }

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

/**
 * Waits for an external event or timeout in a quiescent state.
 *
 * Uses DBOS.recv() with the shortest `after` delay as timeout,
 * implementing the race between external events and delayed transitions.
 */
async function waitForEventOrTimeout(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  options: DurableMachineOptions,
): Promise<AnyMachineSnapshot> {
  const delays = getSortedAfterDelays(machine, snapshot);
  const hasAfter = delays.length > 0;

  const timeoutSec = hasAfter
    ? Math.ceil(delays[0] / 1000) // Round up to nearest second
    : (options.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS);

  // Write wake-up time for KEDA observability
  if (hasAfter) {
    const now = await DBOS.now();
    const wakeAt = now + delays[0];
    await DBOS.setEvent("xstate.wakeAt", wakeAt);
  }

  const event = await DBOS.recv<AnyEventObject>("xstate.event", timeoutSec);

  // Clear wake-up time
  if (hasAfter) {
    await DBOS.setEvent("xstate.wakeAt", null);
  }

  if (event !== null) {
    // External event arrived before timeout
    const [next] = transition(machine, snapshot, event);
    return next;
  }

  if (hasAfter) {
    // Timeout expired — fire the after event
    const afterEvent = buildAfterEvent(machine, snapshot, delays[0]);
    const [next] = transition(machine, snapshot, afterEvent as AnyEventObject);
    return next;
  }

  // No event, no timeout — return same snapshot (loop re-enters)
  return snapshot;
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
