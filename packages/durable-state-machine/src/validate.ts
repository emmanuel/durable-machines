import type { AnyStateMachine } from "xstate";
import { getPromptConfig, getPromptEvents } from "./prompt.js";
import { DurableMachineValidationError } from "./types.js";

const META_KEY = "xstate-dbos";

/**
 * Walks all state nodes in a machine recursively, yielding
 * the dot-separated path and the state node object.
 *
 * @remarks Advanced -- used internally by validation and serialization.
 *
 * @param stateNode - The root state node (or any subtree) to walk
 * @param parentPath - Dot-separated path prefix for the current subtree (default: `""`)
 * @yields `[path, stateNode]` tuples for every descendant state node
 */
export function* walkStateNodes(
  stateNode: any,
  parentPath = "",
): Generator<[string, any]> {
  const states = stateNode.states ?? {};
  for (const [key, child] of Object.entries(states)) {
    const path = parentPath ? `${parentPath}.${key}` : key;
    yield [path, child];
    yield* walkStateNodes(child, path);
  }
}

/**
 * Validates that a machine definition is compatible with durable execution.
 *
 * Checks:
 * - Every non-final state is durable, invoking, or transient
 * - States do not have both `invoke` and `durableState()`
 * - Prompts are only on durable states
 * - Prompt event types match the state's `on` handlers
 * - Machine has an `id`
 *
 * @param machine - The XState machine definition to validate
 * @throws {@link DurableMachineValidationError} with all collected errors if validation fails
 *
 * @example
 * ```ts
 * import { validateMachineForDurability } from "xstate-dbos";
 *
 * try {
 *   validateMachineForDurability(myMachine);
 * } catch (err) {
 *   console.error(err.errors); // string[] of validation issues
 * }
 * ```
 */
export function validateMachineForDurability(machine: AnyStateMachine): void {
  const errors: string[] = [];

  // XState v5 auto-generates an id like "(machine)" if none is provided,
  // but durable machines need a meaningful id for workflow naming
  if (!machine.id || machine.id === "(machine)") {
    errors.push(
      'Machine must have an explicit id (e.g., createMachine({ id: "order", ... })).',
    );
  }

  for (const [path, stateNode] of walkStateNodes(machine.root)) {
    const type: string = stateNode.type;

    // Skip final and history states
    if (type === "final" || type === "history") continue;

    // Compound and parallel states have children — they're structural, not leaf.
    // Only validate leaf (atomic) states.
    if (type === "compound" || type === "parallel") continue;

    const invokeList: any[] = stateNode.invoke ?? [];
    const hasInvoke = invokeList.length > 0;
    const alwaysList: any[] = stateNode.always ?? [];
    const hasAlways = alwaysList.length > 0;
    const meta: Record<string, any> | undefined = stateNode.meta;
    const markedDurable: boolean = meta?.[META_KEY]?.durable === true;
    const promptConfig = getPromptConfig(meta);

    // A non-final atomic state must be one of: durable, invoking, or transient
    if (!hasInvoke && !hasAlways && !markedDurable) {
      errors.push(
        `State "${path}" has no invoke, no always, and is not durableState(). ` +
          `Every non-final state must be exactly one of: durable (waiting for events), ` +
          `invoking (running an actor), or transient (always transition).`,
      );
    }

    // Cannot be both invoking and durable
    if (hasInvoke && markedDurable) {
      errors.push(
        `State "${path}" has both invoke and durableState(). ` +
          `Remove durableState() — invoke states are handled automatically.`,
      );
    }

    // Prompt requires durable
    if (promptConfig && !markedDurable) {
      errors.push(
        `State "${path}" has a prompt but is not durableState(). ` +
          `Prompts only work on durable wait states.`,
      );
    }

    // Prompt events must have matching `on` handlers
    if (promptConfig) {
      const onHandlers = stateNode.on;
      const handledEvents = new Set<string>(
        typeof onHandlers === "object" ? Object.keys(onHandlers) : [],
      );

      for (const eventType of getPromptEvents(promptConfig)) {
        if (!handledEvents.has(eventType)) {
          errors.push(
            `State "${path}" prompt references event "${eventType}" ` +
              `but has no matching "on" handler.`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new DurableMachineValidationError(errors);
  }
}
