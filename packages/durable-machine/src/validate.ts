import type { AnyStateMachine } from "xstate";
import { getPromptConfig, getPromptEvents } from "./prompt.js";
import { getEffectsConfig } from "./effects.js";
import type { EffectHandlerRegistry } from "./effects.js";
import { DurableMachineValidationError } from "./types.js";

const META_KEY = "xstate-durable";

/** Options for {@link validateMachineForDurability}. */
export interface ValidateOptions {
  /** When provided, effect `type` values are checked against this registry. */
  effectHandlers?: EffectHandlerRegistry;
}

/**
 * Minimal structural type for XState state nodes used by {@link walkStateNodes}.
 *
 * Captures the properties accessed by validation and serialization code:
 * `.type`, `.meta`, `.invoke`, `.always`, `.after`, `.on`, `.states`.
 */
export interface StateNodeLike {
  readonly type: string;
  readonly meta?: Record<string, unknown>;
  readonly states?: Record<string, StateNodeLike>;
  readonly invoke?: readonly unknown[];
  readonly always?: readonly unknown[];
  readonly after?: readonly unknown[];
  readonly on?: Record<string, unknown>;
}

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function* walkStateNodes(
  stateNode: any,
  parentPath = "",
): Generator<[string, StateNodeLike]> {
  const states = stateNode.states ?? {};
  for (const [key, child] of Object.entries(states)) {
    const path = parentPath ? `${parentPath}.${key}` : key;
    yield [path, child as StateNodeLike];
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
 * @param options - Optional validation settings (e.g. effect handler registry)
 * @throws {@link DurableMachineValidationError} with all collected errors if validation fails
 *
 * @example
 * ```ts
 * import { validateMachineForDurability } from "@durable-xstate/durable-machine";
 *
 * try {
 *   validateMachineForDurability(myMachine);
 * } catch (err) {
 *   console.error(err.errors); // string[] of validation issues
 * }
 * ```
 */
export function validateMachineForDurability(
  machine: AnyStateMachine,
  options?: ValidateOptions,
): void {
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

    const invokeList = stateNode.invoke ?? [];
    const hasInvoke = invokeList.length > 0;
    const alwaysList = stateNode.always ?? [];
    const hasAlways = alwaysList.length > 0;
    const meta = stateNode.meta as Record<string, any> | undefined;
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

    // Effects validation
    const effectConfigs = getEffectsConfig(meta);
    if (effectConfigs) {
      // Effects on transient (always-only) states are not allowed
      if (hasAlways && !markedDurable && !hasInvoke) {
        errors.push(
          `State "${path}" has effects on a transient (always) state. ` +
            `Effects are only allowed on durable or invoke states.`,
        );
      }

      for (const effect of effectConfigs) {
        // Every effect must have a type
        if (!effect.type) {
          errors.push(
            `State "${path}" has an effect without a "type" field.`,
          );
        }

        // If handler registry is provided, check that handler exists
        if (effect.type && options?.effectHandlers) {
          if (!options.effectHandlers.handlers.has(effect.type)) {
            errors.push(
              `State "${path}" has effect type "${effect.type}" ` +
                `not found in effect handler registry.`,
            );
          }
        }

        // Check template syntax in effect payload values
        validateEffectTemplates(effect, path, errors);
      }
    }
  }

  if (errors.length > 0) {
    throw new DurableMachineValidationError(errors);
  }
}

function validateEffectTemplates(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (typeof value === "string") {
    const opens = (value.match(/\{\{/g) ?? []).length;
    const closes = (value.match(/\}\}/g) ?? []).length;
    if (opens !== closes) {
      errors.push(
        `State "${path}" has unbalanced template expression in effect value "${value}".`,
      );
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      validateEffectTemplates(item, path, errors);
    }
    return;
  }

  if (typeof value === "object" && value !== null) {
    for (const val of Object.values(value)) {
      validateEffectTemplates(val, path, errors);
    }
  }
}
