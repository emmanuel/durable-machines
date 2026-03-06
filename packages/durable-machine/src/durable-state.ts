import type { AnyStateMachine, AnyMachineSnapshot } from "xstate";

const META_KEY = "xstate-durable";

/**
 * Marks a state as durable — a persistent wait point where the machine
 * parks and waits for an external event or timeout.
 *
 * Spread into a state definition:
 * ```ts
 * pending: { ...durableState(), on: { PAY: "processing" } }
 * ```
 */
export function durableState() {
  return { meta: { [META_KEY]: { durable: true } } } as const;
}

/**
 * Returns true if the given snapshot is in a durable state.
 *
 * Works for both simple and compound state values by checking all
 * active state nodes for the durable marker.
 *
 * @param _machine - The XState machine definition (reserved for future use)
 * @param snapshot - The current machine snapshot to check
 * @returns `true` if any active state node is marked as a durable state
 */
export function isDurableState(
  _machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
): boolean {
  const stateNodes = snapshot._nodes;
  return stateNodes.some(
    (node: any) => node.meta?.[META_KEY]?.durable === true,
  );
}
