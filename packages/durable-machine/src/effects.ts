const META_KEY = "xstate-durable";

/**
 * Declarative configuration for a side effect to execute on state entry.
 * Spread into a state definition via `durableState({ effects: [...] })` or
 * `prompt(config, { effects: [...] })`.
 */
export interface EffectConfig {
  /** Handler name — must match a key in the {@link EffectHandlerRegistry}. */
  type: string;
  /** Arbitrary payload. Values may contain `{{ template }}` expressions. */
  [key: string]: unknown;
}

/**
 * An effect whose template expressions have been resolved against the
 * current machine context and event.
 */
export interface ResolvedEffect {
  type: string;
  [key: string]: unknown;
}

/** An async function that executes a single resolved effect. */
export interface EffectHandler {
  (effect: ResolvedEffect): Promise<void>;
}

/** A frozen registry mapping effect type names to their handlers. */
export interface EffectHandlerRegistry {
  readonly handlers: ReadonlyMap<string, EffectHandler>;
}

/**
 * Creates an {@link EffectHandlerRegistry} from a plain record of handlers.
 *
 * @param handlers - Record mapping effect type names to handler functions
 * @returns A frozen registry with a `Map`-based lookup
 */
export function createEffectHandlers(
  handlers: Record<string, EffectHandler>,
): EffectHandlerRegistry {
  const map = new Map(Object.entries(handlers));
  const registry: EffectHandlerRegistry = { handlers: map };
  return Object.freeze(registry);
}

/**
 * Extracts the effects config array from a state node's metadata, if present.
 *
 * @param stateNodeMeta - The `.meta` object from a state node
 * @returns The array of {@link EffectConfig} if present, or `null`
 */
export function getEffectsConfig(
  stateNodeMeta: Record<string, any> | undefined,
): EffectConfig[] | null {
  const effects = stateNodeMeta?.[META_KEY]?.effects;
  if (Array.isArray(effects) && effects.length > 0) return effects;
  return null;
}
