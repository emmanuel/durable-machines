import type { AnyStateMachine, AnyMachineSnapshot } from "xstate";

const META_KEY = "xstate-dbos";

/**
 * Marks a state as quiescent — a durable wait point where the machine
 * parks and waits for an external event or timeout.
 *
 * Spread into a state definition:
 * ```ts
 * pending: { ...quiescent(), on: { PAY: "processing" } }
 * ```
 */
export function quiescent() {
  return { meta: { [META_KEY]: { quiescent: true } } } as const;
}

/**
 * Returns true if the given snapshot is in a quiescent state.
 *
 * Works for both simple and compound state values by checking all
 * active state nodes for the quiescent marker.
 *
 * @param _machine - The XState machine definition (reserved for future use)
 * @param snapshot - The current machine snapshot to check
 * @returns `true` if any active state node is marked quiescent
 */
export function isQuiescent(
  _machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
): boolean {
  const stateNodes = snapshot._nodes;
  return stateNodes.some(
    (node: any) => node.meta?.[META_KEY]?.quiescent === true,
  );
}
