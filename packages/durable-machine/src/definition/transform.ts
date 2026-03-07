import type { MachineDefinition, StateDefinition, TransitionDefinition, InvokeDefinition } from "./types.js";
import type { ImplementationRegistry } from "./registry.js";
import { isRef, resolveExpressions, resolveTemplate } from "./expressions.js";
import type { PromptConfig } from "../types.js";

const META_KEY = "xstate-durable";

/**
 * Transforms a JSON machine definition into an XState-compatible config object.
 *
 * The returned config can be passed to `setup(...).createMachine(config)`.
 */
export function transformDefinition(
  definition: MachineDefinition,
  _registry: ImplementationRegistry,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    id: definition.id,
    initial: definition.initial,
    states: transformStates(definition.states),
  };

  // Context: static defaults merged with input at runtime
  if (definition.context) {
    const staticDefaults = { ...definition.context };
    config.context = ({ input }: { input?: Record<string, unknown> }) => ({
      ...staticDefaults,
      ...input,
    });
  }

  return config;
}

function transformStates(
  states: Record<string, StateDefinition>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, state] of Object.entries(states)) {
    result[key] = transformState(state);
  }
  return result;
}

function transformState(state: StateDefinition): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  // Type
  if (state.type) {
    config.type = state.type;
  }

  // Initial (compound states)
  if (state.initial) {
    config.initial = state.initial;
  }

  // Child states
  if (state.states) {
    config.states = transformStates(state.states);
  }

  // Meta: durable + prompt
  const meta = buildMeta(state);
  if (meta) {
    config.meta = meta;
  }

  // on transitions
  if (state.on) {
    const on: Record<string, unknown> = {};
    for (const [eventType, trans] of Object.entries(state.on)) {
      on[eventType] = transformTransitionOrArray(trans);
    }
    config.on = on;
  }

  // always transitions
  if (state.always) {
    config.always = transformTransitionOrArray(state.always);
  }

  // after transitions
  if (state.after) {
    const after: Record<string | number, unknown> = {};
    for (const [delay, trans] of Object.entries(state.after)) {
      // Parse numeric string keys to numbers
      const key = isFinite(Number(delay)) ? Number(delay) : delay;
      after[key] = transformTransitionOrArray(trans);
    }
    config.after = after;
  }

  // invoke
  if (state.invoke) {
    const invokeList = Array.isArray(state.invoke) ? state.invoke : [state.invoke];
    const transformed = invokeList.map(transformInvoke);
    config.invoke = transformed.length === 1 ? transformed[0] : transformed;
  }

  return config;
}

function buildMeta(state: StateDefinition): Record<string, unknown> | undefined {
  const isDurable = state.durable === true || state.prompt != null;
  if (!isDurable) return undefined;

  const durableMeta: Record<string, unknown> = { durable: true };

  if (state.prompt) {
    durableMeta.prompt = transformPrompt(state.prompt);
  }

  return { [META_KEY]: durableMeta };
}

function transformPrompt(prompt: PromptConfig): PromptConfig {
  // If text contains template expressions, wrap it in a function
  if (typeof prompt.text === "string" && prompt.text.includes("{{")) {
    const template = prompt.text;
    return {
      ...prompt,
      text: ({ context }: { context: Record<string, unknown> }) =>
        resolveTemplate(template, { context }),
    } as PromptConfig;
  }
  return prompt;
}

function transformTransitionOrArray(
  trans: TransitionDefinition | TransitionDefinition[],
): unknown {
  if (Array.isArray(trans)) {
    return trans.map(transformTransition);
  }
  return transformTransition(trans);
}

function transformTransition(trans: TransitionDefinition): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (trans.target !== undefined) {
    result.target = trans.target;
  }

  if (trans.guard !== undefined) {
    result.guard = trans.guard;
  }

  if (trans.actions !== undefined) {
    result.actions = trans.actions;
  }

  return result;
}

function transformInvoke(inv: InvokeDefinition): Record<string, unknown> {
  const result: Record<string, unknown> = {
    src: inv.src,
  };

  if (inv.id) {
    result.id = inv.id;
  }

  // Input: resolve $ref expressions at runtime
  if (inv.input) {
    if (isRef(inv.input)) {
      const ref = inv.input.$ref;
      result.input = ({ context, event }: { context: Record<string, unknown>; event?: any }) =>
        resolveExpressions({ $ref: ref }, { context, event });
    } else {
      const defInput = inv.input;
      result.input = ({ context, event }: { context: Record<string, unknown>; event?: any }) =>
        resolveExpressions(defInput, { context, event });
    }
  }

  if (inv.onDone !== undefined) {
    result.onDone = typeof inv.onDone === "string"
      ? { target: inv.onDone }
      : transformTransition(inv.onDone);
  }

  if (inv.onError !== undefined) {
    result.onError = typeof inv.onError === "string"
      ? { target: inv.onError }
      : transformTransition(inv.onError);
  }

  return result;
}
