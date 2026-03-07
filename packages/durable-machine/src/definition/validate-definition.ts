import type { MachineDefinition, StateDefinition, TransitionDefinition } from "./types.js";
import type { ImplementationRegistry } from "./registry.js";
import { getPromptEvents } from "../prompt.js";

/** Structured validation result suitable for API responses. */
export interface DefinitionValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates a JSON machine definition against a registry, returning structured results.
 *
 * Checks:
 * 1. Every actor `src`, guard `type`, action `type`, delay name exists in registry
 * 2. State structure: initial states exist, targets resolve
 * 3. Durability rules: every non-final atomic state is durable, invoking, or transient
 * 4. Expression syntax: `$ref` paths have valid prefix, `{{ }}` pairs balanced
 * 5. Registry binding: if `definition.registryId` is set, must match `registry.id`
 * 6. Prompt validation: prompt states must be durable, prompt events must have `on` handlers
 */
export function validateDefinition(
  definition: MachineDefinition,
  registry: ImplementationRegistry,
): DefinitionValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Registry binding check
  if (definition.registryId !== undefined && definition.registryId !== registry.id) {
    errors.push(
      `Definition registryId "${definition.registryId}" does not match registry id "${registry.id}".`,
    );
  }

  // Machine must have id
  if (!definition.id) {
    errors.push("Machine definition must have a non-empty id.");
  }

  // Initial state must exist
  if (!definition.states[definition.initial]) {
    errors.push(
      `Initial state "${definition.initial}" does not exist in top-level states.`,
    );
  }

  // Walk all states
  walkStates(definition.states, "", definition.states, registry, errors, warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function walkStates(
  states: Record<string, StateDefinition>,
  parentPath: string,
  rootStates: Record<string, StateDefinition>,
  registry: ImplementationRegistry,
  errors: string[],
  warnings: string[],
): void {
  for (const [key, state] of Object.entries(states)) {
    const path = parentPath ? `${parentPath}.${key}` : key;
    validateStateNode(path, state, states, rootStates, registry, errors, warnings);

    // Recurse into children
    if (state.states) {
      walkStates(state.states, path, rootStates, registry, errors, warnings);
    }
  }
}

function validateStateNode(
  path: string,
  state: StateDefinition,
  siblingStates: Record<string, StateDefinition>,
  rootStates: Record<string, StateDefinition>,
  registry: ImplementationRegistry,
  errors: string[],
  warnings: string[],
): void {
  const type = resolveStateType(state);

  // Compound states must have initial
  if (type === "compound" && !state.initial) {
    errors.push(`Compound state "${path}" must have an "initial" property.`);
  }

  // Compound initial must exist in children
  if (type === "compound" && state.initial && state.states && !state.states[state.initial]) {
    errors.push(
      `Compound state "${path}" initial "${state.initial}" does not exist in child states.`,
    );
  }

  // Skip structural and terminal checks for non-leaf states
  if (type === "final" || type === "history" || type === "compound" || type === "parallel") {
    // Still validate transitions on these states
    validateTransitions(path, state, siblingStates, rootStates, registry, errors);
    return;
  }

  // Atomic state durability checks
  const invokeList = normalizeArray(state.invoke);
  const hasInvoke = invokeList.length > 0;
  const alwaysList = normalizeArray(state.always);
  const hasAlways = alwaysList.length > 0;
  const markedDurable = state.durable === true || state.prompt != null;

  if (!hasInvoke && !hasAlways && !markedDurable) {
    errors.push(
      `State "${path}" has no invoke, no always, and is not durable. ` +
        `Every non-final state must be exactly one of: durable (waiting for events), ` +
        `invoking (running an actor), or transient (always transition).`,
    );
  }

  if (hasInvoke && markedDurable) {
    errors.push(
      `State "${path}" has both invoke and durable. ` +
        `Remove durable — invoke states are handled automatically.`,
    );
  }

  // Prompt event handlers
  if (state.prompt) {
    const onHandlers = state.on ?? {};
    const handledEvents = new Set(Object.keys(onHandlers));

    for (const eventType of getPromptEvents(state.prompt)) {
      if (!handledEvents.has(eventType)) {
        errors.push(
          `State "${path}" prompt references event "${eventType}" ` +
            `but has no matching "on" handler.`,
        );
      }
    }
  }

  // Effects validation
  if (state.effects) {
    // Effects on transient (always-only) states are not allowed
    if (hasAlways && !markedDurable && !hasInvoke) {
      errors.push(
        `State "${path}" has effects on a transient (always) state. ` +
          `Effects are only allowed on durable or invoke states.`,
      );
    }

    for (const effect of state.effects) {
      if (!effect.type) {
        errors.push(
          `State "${path}" has an effect without a "type" field.`,
        );
      }

      // Validate template syntax in effect payload values
      validateExpressions(effect, path, errors);
    }
  }

  // Validate transitions, invokes, etc.
  validateTransitions(path, state, siblingStates, rootStates, registry, errors);
}

function validateTransitions(
  path: string,
  state: StateDefinition,
  siblingStates: Record<string, StateDefinition>,
  rootStates: Record<string, StateDefinition>,
  registry: ImplementationRegistry,
  errors: string[],
): void {
  // Validate `on` transitions
  if (state.on) {
    for (const [eventType, trans] of Object.entries(state.on)) {
      for (const t of normalizeArray(trans)) {
        validateTransition(path, `on.${eventType}`, t, siblingStates, rootStates, registry, errors);
      }
    }
  }

  // Validate `always` transitions
  if (state.always) {
    for (const t of normalizeArray(state.always)) {
      validateTransition(path, "always", t, siblingStates, rootStates, registry, errors);
    }
  }

  // Validate `after` transitions
  if (state.after) {
    for (const [delay, trans] of Object.entries(state.after)) {
      // Check if delay is a named delay (non-numeric string)
      if (isNaN(Number(delay)) && !(delay in registry.delays)) {
        errors.push(
          `State "${path}" references delay "${delay}" not found in registry.`,
        );
      }
      for (const t of normalizeArray(trans)) {
        validateTransition(path, `after.${delay}`, t, siblingStates, rootStates, registry, errors);
      }
    }
  }

  // Validate invocations
  const invokeList = normalizeArray(state.invoke);
  for (const inv of invokeList) {
    if (!(inv.src in registry.actors)) {
      errors.push(
        `State "${path}" invokes actor "${inv.src}" not found in registry.`,
      );
    }

    if (inv.onDone) {
      const t = typeof inv.onDone === "string" ? { target: inv.onDone } : inv.onDone;
      validateTransition(path, `invoke.onDone`, t, siblingStates, rootStates, registry, errors);
    }
    if (inv.onError) {
      const t = typeof inv.onError === "string" ? { target: inv.onError } : inv.onError;
      validateTransition(path, `invoke.onError`, t, siblingStates, rootStates, registry, errors);
    }

    // Validate input expressions
    if (inv.input) {
      validateExpressions(inv.input, path, errors);
    }
  }
}

function validateTransition(
  statePath: string,
  transDesc: string,
  trans: TransitionDefinition,
  siblingStates: Record<string, StateDefinition>,
  rootStates: Record<string, StateDefinition>,
  registry: ImplementationRegistry,
  errors: string[],
): void {
  // Validate target exists
  if (trans.target) {
    const targetKey = trans.target.startsWith(".")
      ? trans.target.slice(1) // relative target
      : trans.target;

    // Check if target is a sibling state or a root-level dotted path
    if (!siblingStates[targetKey] && !resolveTarget(targetKey, rootStates)) {
      errors.push(
        `State "${statePath}" ${transDesc} targets "${trans.target}" which does not exist.`,
      );
    }
  }

  // Validate guard
  if (trans.guard) {
    const guardType = typeof trans.guard === "string" ? trans.guard : trans.guard.type;
    if (!(guardType in registry.guards)) {
      errors.push(
        `State "${statePath}" ${transDesc} references guard "${guardType}" not found in registry.`,
      );
    }
  }

  // Validate actions
  if (trans.actions) {
    const actionList = typeof trans.actions === "string"
      ? [trans.actions]
      : Array.isArray(trans.actions)
        ? trans.actions
        : [];

    for (const action of actionList) {
      const actionType = typeof action === "string" ? action : action.type;
      if (!(actionType in registry.actions)) {
        errors.push(
          `State "${statePath}" ${transDesc} references action "${actionType}" not found in registry.`,
        );
      }
    }
  }
}

/** Resolve a dot-path target through nested states. */
function resolveTarget(
  target: string,
  rootStates: Record<string, StateDefinition>,
): StateDefinition | undefined {
  const segments = target.split(".");
  let current: Record<string, StateDefinition> | undefined = rootStates;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!current || !(segment in current)) return undefined;
    const found: StateDefinition = current[segment];
    if (i === segments.length - 1) return found;
    current = found.states;
  }
  return undefined;
}

function validateExpressions(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if ("$ref" in value && typeof (value as any).$ref === "string") {
      const ref = (value as any).$ref as string;
      const prefix = ref.split(".")[0];
      if (!["context", "event", "input"].includes(prefix)) {
        errors.push(
          `State "${path}" has $ref "${ref}" with invalid prefix "${prefix}". ` +
            `Must start with "context.", "event.", or "input.".`,
        );
      }
      return;
    }
    for (const val of Object.values(value)) {
      validateExpressions(val, path, errors);
    }
    return;
  }

  if (typeof value === "string") {
    // Check for unbalanced {{ }}
    const opens = (value.match(/\{\{/g) ?? []).length;
    const closes = (value.match(/\}\}/g) ?? []).length;
    if (opens !== closes) {
      errors.push(
        `State "${path}" has unbalanced template expression in "${value}".`,
      );
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      validateExpressions(item, path, errors);
    }
  }
}

function resolveStateType(
  state: StateDefinition,
): "atomic" | "compound" | "parallel" | "final" | "history" {
  if (state.type) return state.type;
  if (state.states) return "compound";
  return "atomic";
}

function normalizeArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
