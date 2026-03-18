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

/** Context passed to effect handlers at execution time. */
export interface EffectHandlerContext {
  tenantId?: string;
}

/** An async function that executes a single resolved effect. */
export interface EffectHandler {
  (effect: ResolvedEffect, ctx?: EffectHandlerContext): Promise<void>;
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
export function createEffectHandlerRegistry(
  handlers: Record<string, EffectHandler>,
): EffectHandlerRegistry {
  const map = new Map(Object.entries(handlers));
  const registry: EffectHandlerRegistry = { handlers: map };
  return Object.freeze(registry);
}

/** @deprecated Use {@link createEffectHandlerRegistry}. */
export const createEffectHandlers = createEffectHandlerRegistry;

/** A compiled effect resolver function. */
export type CompiledEffectResolver = (args: { context: Record<string, unknown>; event?: Record<string, unknown> }) => unknown;

/**
 * Extracts the raw effect configs from a state node's metadata, if present.
 *
 * Used by validation and serialization which need the original EffectConfig objects.
 *
 * @param stateNodeMeta - The `.meta` object from a state node
 * @returns The array of raw EffectConfig objects if present, or `null`
 */
export function getEffectsConfig(
  stateNodeMeta: Record<string, any> | undefined,
): EffectConfig[] | null {
  const effects = stateNodeMeta?.[META_KEY]?.effects;
  if (Array.isArray(effects) && effects.length > 0) return effects;
  return null;
}

/**
 * Extracts the compiled effect resolvers from a state node's metadata, if present.
 *
 * Used at runtime by `collectAndResolveEffects()` which needs compiled functions.
 *
 * @param stateNodeMeta - The `.meta` object from a state node
 * @returns The array of compiled effect resolvers if present, or `null`
 */
export function getCompiledEffects(
  stateNodeMeta: Record<string, any> | undefined,
): CompiledEffectResolver[] | null {
  const compiled = stateNodeMeta?.[META_KEY]?.compiledEffects;
  if (Array.isArray(compiled) && compiled.length > 0) return compiled;
  return null;
}
