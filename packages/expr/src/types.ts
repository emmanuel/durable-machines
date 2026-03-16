// ─── Scope ──────────────────────────────────────────────────────────────────

/** Evaluation scope — the data available to every expression. */
export interface Scope {
  context: Record<string, unknown>;
  event: Record<string, unknown>;
  params: Record<string, unknown>;
  /** Named values from `let` bindings. Extend via spreading. */
  bindings: Record<string, unknown>;
}

/** Create a scope with defaults for optional fields. */
export function createScope(partial: {
  context: Record<string, unknown>;
  event?: Record<string, unknown>;
  params?: Record<string, unknown>;
}): Scope {
  return {
    context: partial.context,
    event: partial.event ?? {},
    params: partial.params ?? {},
    bindings: {},
  };
}

// ─── Expressions ────────────────────────────────────────────────────────────

/**
 * An expression is any JSON value that the evaluator can process.
 * Literals (string, number, boolean, null) evaluate to themselves.
 * Objects with operator keys are evaluated according to the operator.
 */
export type Expr = unknown;

// ─── Path Navigators ────────────────────────────────────────────────────────

/**
 * A step in a path traversal.
 *
 * In addition to the named navigator shapes below, any expression object
 * (e.g. `{select: ["event", "sessionId"]}`) is accepted as a path step.
 * It is evaluated at runtime and its result is coerced to a string key.
 * This allows dynamic keys computed from arbitrary expressions without
 * needing a `let` binding.
 */
export type PathNavigator =
  | string                                        // static key
  | { param: string }                             // dynamic key from params
  | { ref: string }                               // dynamic key from bindings
  | { where: Record<string, unknown> }            // filter collection entries
  | { all: true }                                 // all elements
  | { first: true }                               // first element
  | { last: true }                                // last element
  | Record<string, unknown>;                      // arbitrary expr → dynamic key

/** A path is an array of navigators. */
export type Path = PathNavigator[];

// ─── Transforms ─────────────────────────────────────────────────────────────

/** A single path transform (used in assign actions). */
export interface Transform {
  path: Path;
  set?: Expr;
  append?: Expr;
  remove?: true;
  apply?: string;
  args?: Expr[];
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** An assign action definition. */
export interface AssignActionDef {
  type: "assign";
  let?: Record<string, Expr>;
  transforms: Transform[];
}

/** An emit action definition. */
export interface EmitActionDef {
  type: "emit";
  event: Record<string, Expr>;
}

/** A raise action definition. */
export interface RaiseActionDef {
  type: "raise";
  event: Record<string, Expr>;
  delay?: Expr;
  id?: string;
}

/** A guarded action block (within enqueueActions). */
export interface GuardedBlock {
  guard: Expr;
  actions: ActionDef[];
}

/** An enqueueActions definition. */
export interface EnqueueActionsDef {
  type: "enqueueActions";
  let?: Record<string, Expr>;
  actions: (ActionDef | GuardedBlock)[];
}

/** Any action definition. */
export type ActionDef = AssignActionDef | EmitActionDef | RaiseActionDef | EnqueueActionsDef;

/** Result of evaluating an action. */
export type ActionResult =
  | { type: "assign"; context: Record<string, unknown> }
  | { type: "emit"; event: Record<string, unknown> }
  | { type: "raise"; event: Record<string, unknown>; delay?: number; id?: string };

// ─── Builtins ───────────────────────────────────────────────────────────────

/** A registered builtin function. */
export type BuiltinFn = (...args: unknown[]) => unknown;

/** Registry of builtin functions keyed by name. */
export type BuiltinRegistry = Record<string, BuiltinFn>;

// ─── Compiled expressions ───────────────────────────────────────────────────

/** A pre-compiled expression — call with a scope to evaluate. */
export type CompiledExpr = (scope: Scope) => unknown;
