import type {
  AnyStateMachine,
  AnyMachineSnapshot,
  AnyEventObject,
} from "xstate";
import { transition } from "xstate";
import type { DurableStateSnapshot, InvocationInfo } from "./types.js";

/**
 * Returns the active invocation for the current snapshot, if the machine
 * is in a state with an `invoke` definition.
 *
 * Only supports a single invoke per state (the first one). Multi-invoke
 * states are a future consideration.
 *
 * @remarks Advanced -- inspects internal XState state node structures.
 *
 * @param _machine - The XState machine definition (reserved for future use)
 * @param snapshot - The current machine snapshot to inspect
 * @returns An {@link InvocationInfo} for the first active invoke, or `null` if none
 */
export function getActiveInvocation(
  _machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
): InvocationInfo | null {
  for (const node of snapshot._nodes) {
    const invokeList: any[] = node.invoke ?? [];
    if (invokeList.length === 0) continue;

    const inv = invokeList[0];
    const src =
      typeof inv.src === "string" ? inv.src : inv.src?.config?.id ?? inv.id;

    // Resolve input — invoke input can be a mapper function or a static value
    let input: unknown;
    if (typeof inv.input === "function") {
      try {
        input = inv.input({
          context: snapshot.context,
          event: { type: "xstate.init" } as AnyEventObject,
        });
      } catch {
        input = undefined;
      }
    } else {
      input = inv.input;
    }

    return { id: inv.id, src, input };
  }

  return null;
}

/**
 * Extracts actor implementations from the machine's registered implementations.
 *
 * Returns a map of actor source name → executor function. The executor
 * is the raw `fromPromise` (or other actor logic) registered via `setup({ actors: {...} })`.
 */
export function extractActorImplementations(
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

/**
 * Returns the `after` delays for the current snapshot's active state nodes,
 * sorted in ascending order (smallest delay first).
 *
 * Delays can be static numbers, named delays (resolved from machine config),
 * or dynamic delay expressions. Only numeric delays are returned; named/dynamic
 * delays are resolved if possible.
 */
export function getSortedAfterDelays(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
): number[] {
  const delays: number[] = [];

  for (const node of snapshot._nodes) {
    const afterDefs: any[] = node.after ?? [];

    for (const def of afterDefs) {
      const delay = resolveDelay(def.delay, machine, snapshot);
      if (delay !== null) {
        delays.push(delay);
      }
    }
  }

  return delays.sort((a, b) => a - b);
}

/**
 * Resolves a delay value to a number of milliseconds.
 */
function resolveDelay(
  delay: number | string | ((...args: any[]) => number),
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
): number | null {
  if (typeof delay === "number") return delay;

  if (typeof delay === "function") {
    try {
      return delay({ context: snapshot.context, event: { type: "xstate.init" } });
    } catch {
      return null;
    }
  }

  if (typeof delay === "string") {
    // Look up named delay in machine implementations
    const delayImpl = (machine as any).implementations?.delays?.[delay];
    if (typeof delayImpl === "number") return delayImpl;
    if (typeof delayImpl === "function") {
      try {
        return delayImpl({ context: snapshot.context, event: { type: "xstate.init" } });
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Builds the XState internal event object for a fired `after` delay.
 *
 * XState v5 uses the event type format: `xstate.after.{delay}.{stateId}`
 */
export function buildAfterEvent(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  delay: number,
): AnyEventObject {
  // Find the state node that owns this delay by resolving all delay types
  for (const node of snapshot._nodes) {
    const afterDefs: any[] = node.after ?? [];
    for (const def of afterDefs) {
      const resolvedDelay = resolveDelay(def.delay, machine, snapshot);
      if (resolvedDelay === delay) {
        // Use the event type from the transition definition itself
        // XState stores the event descriptor on the transition
        if (def.eventType && typeof def.eventType === "string") {
          return { type: def.eventType };
        }
        // Fallback: construct the event type manually
        return { type: `xstate.after.${delay}.${node.id}` };
      }
    }
  }

  // Fallback if no matching node found — shouldn't happen in practice
  return { type: `xstate.after.${delay}` };
}

/**
 * Resolves transient (always/eventless) transitions by repeatedly applying
 * `machine.transition` until the snapshot stabilizes on a non-transient state.
 *
 * Guards a max iteration count to prevent infinite loops from misconfigured
 * always transitions.
 */
export function resolveTransientTransitions(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  maxIterations = 100,
): AnyMachineSnapshot {
  let current = snapshot;

  for (let i = 0; i < maxIterations; i++) {
    // Check if any active node has `always` transitions
    const hasAlways = current._nodes.some(
      (node: any) => (node.always?.length ?? 0) > 0,
    );
    if (!hasAlways) return current;

    // Send a synthetic eventless transition to trigger `always`
    // In XState v5, always transitions are evaluated on entry automatically
    // by the transition function. We trigger re-evaluation by sending
    // an event that won't match any `on` handler — the always transitions
    // will fire if their guards pass.
    const [next] = transition(machine, current, {
      type: "xstate.__internal.resolve",
    } as any);

    // If state didn't change, we've stabilized
    if (stateValueEquals(current.value, next.value)) return current;
    current = next;
  }

  return current;
}

/**
 * Serializes a machine snapshot into a `DurableStateSnapshot` suitable
 * for storage and external consumption.
 */
export function serializeSnapshot(
  snapshot: AnyMachineSnapshot,
): DurableStateSnapshot {
  return {
    value: snapshot.value,
    context: snapshot.context as Record<string, unknown>,
    status:
      snapshot.status === "done"
        ? "done"
        : snapshot.status === "error"
          ? "error"
          : "running",
  };
}

/**
 * Checks whether a specific `after` delay on the current snapshot has
 * `reenter: true`, indicating that the state will be exited and re-entered
 * (timers restart, entry actions fire again).
 */
export function isReentryDelay(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  delay: number,
): boolean {
  for (const node of snapshot._nodes) {
    const afterDefs: any[] = node.after ?? [];
    for (const def of afterDefs) {
      const resolvedDelay = resolveDelay(def.delay, machine, snapshot);
      if (resolvedDelay === delay) {
        return def.reenter === true;
      }
    }
  }
  return false;
}

/**
 * Compares two state values for structural equality.
 *
 * @param a - First state value (string or nested object)
 * @param b - Second state value (string or nested object)
 * @returns `true` if the two state values are structurally equal
 *
 * @example
 * ```ts
 * stateValueEquals("idle", "idle"); // true
 * stateValueEquals({ active: "running" }, { active: "running" }); // true
 * stateValueEquals({ active: "running" }, { active: "paused" }); // false
 * ```
 */
export function stateValueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "string") return a === b;
  if (typeof a === "object" && a !== null && b !== null) {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      stateValueEquals(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
    );
  }
  return false;
}
