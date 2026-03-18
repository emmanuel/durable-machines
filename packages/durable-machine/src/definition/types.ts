import type { PromptConfig } from "../types.js";
import type { EffectConfig } from "../effects.js";

// ─── Machine Definition ─────────────────────────────────────────────────────

/** A serializable JSON representation of an XState machine. */
export interface MachineDefinition {
  /** Unique machine identifier (required — must not be empty). */
  id: string;
  /** Key of the initial child state. */
  initial: string;
  /** Static default context values. Merged with runtime `input` at creation. */
  context?: Record<string, unknown>;
  /** State definitions keyed by state name. */
  states: Record<string, StateDefinition>;
  /** Optional binding to a specific {@link ImplementationRegistry.id}. */
  registryId?: string;
  /**
   * Named guard expressions. Each key is a guard name referenced by transitions.
   * At machine creation time, each expr is compiled into a closure.
   */
  guards?: Record<string, unknown>;
  /**
   * Named action expressions. Each key is an action name referenced by transitions.
   * Values are ActionDef objects from @durable-machines/expr.
   * At machine creation time, each expr is compiled into a closure.
   */
  actions?: Record<string, unknown>;
}

// ─── State Definition ───────────────────────────────────────────────────────

/** A serializable JSON representation of a single state node. */
export interface StateDefinition {
  /** XState state node type. Defaults to `"atomic"` (or `"compound"` when `states` is present). */
  type?: "atomic" | "compound" | "parallel" | "final" | "history";
  /** Key of the initial child state (required for compound states). */
  initial?: string;
  /** Nested child states (makes this a compound or parallel state). */
  states?: Record<string, StateDefinition>;
  /** Marks this state as a durable wait point. Equivalent to `durableState()`. */
  durable?: boolean;
  /** Prompt configuration for this state. Implies `durable: true`. Equivalent to `prompt()`. */
  prompt?: PromptConfig;
  /** Event-driven transitions, keyed by event type. */
  on?: Record<string, TransitionDefinition | TransitionDefinition[]>;
  /** Eventless (always) transitions. */
  always?: TransitionDefinition | TransitionDefinition[];
  /** Delayed transitions, keyed by delay (numeric ms or named delay). */
  after?: Record<string, TransitionDefinition | TransitionDefinition[]>;
  /** Invoked actors. */
  invoke?: InvokeDefinition | InvokeDefinition[];
  /** Effects to fire on state entry. */
  effects?: EffectConfig[];
}

// ─── Transition Definition ──────────────────────────────────────────────────

/** A serializable transition. */
export interface TransitionDefinition {
  /** Target state key (relative or absolute). */
  target?: string;
  /** Guard name or guard with params. XState resolves named guards natively. */
  guard?: string | { type: string; params?: Record<string, unknown> };
  /** Action name(s) or action objects. XState resolves named actions natively. */
  actions?: string | ActionDefinition | (string | ActionDefinition)[];
}

/** A named action with optional static params. */
export interface ActionDefinition {
  type: string;
  params?: Record<string, unknown>;
}

// ─── Invoke Definition ──────────────────────────────────────────────────────

/** A serializable actor invocation. */
export interface InvokeDefinition {
  /** Actor name (must exist in the implementation registry). */
  src: string;
  /** Invocation ID. Defaults to XState's auto-generated ID. */
  id?: string;
  /** Input expression — `$ref`, expr operator, or static value, resolved at runtime. */
  input?: unknown;
  /** Transition on successful completion. String shorthand resolves to `{ target: "stateName" }`. */
  onDone?: TransitionDefinition | string;
  /** Transition on error. String shorthand resolves to `{ target: "stateName" }`. */
  onError?: TransitionDefinition | string;
}

export type { PromptConfig };
