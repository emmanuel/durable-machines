import type { Expr, Scope, BuiltinRegistry } from "./types.js";
import { parseDollarPath } from "./desugar.js";

/** Evaluator function signature — injected to avoid circular imports. */
type EvaluatorFn = (expr: Expr, scope: Scope, builtins?: BuiltinRegistry) => unknown;

/**
 * Rewrite bare strings in operator positions within a `where` predicate
 * so they are treated as field references (`{ref: ...}`) rather than literals.
 *
 * This allows ergonomic predicates like `{ in: ["state", ["launched", "active"]] }`
 * where `"state"` is meant to refer to the entry's `state` field.
 */
export function rewriteWhereStrings(expr: Expr): Expr {
  if (typeof expr !== "object" || expr === null || Array.isArray(expr)) {
    return expr;
  }

  const op = expr as Record<string, unknown>;

  // Binary comparisons: wrap only the FIRST operand (the field reference) if a bare string.
  // The second operand is the comparison value and should remain a literal.
  for (const binOp of ["eq", "neq", "gt", "lt", "gte", "lte"] as const) {
    if (binOp in op) {
      const [a, b] = op[binOp] as [Expr, Expr];
      return { [binOp]: [wrapIfString(a), b] };
    }
  }

  // in: wrap ONLY the first operand (the value), NOT the array
  if ("in" in op) {
    const [value, array] = op.in as [Expr, Expr];
    return { in: [wrapIfString(value), array] };
  }

  // Logic: recurse into each element
  if ("and" in op) {
    const exprs = op.and as Expr[];
    return { and: exprs.map(rewriteWhereStrings) };
  }
  if ("or" in op) {
    const exprs = op.or as Expr[];
    return { or: exprs.map(rewriteWhereStrings) };
  }
  if ("not" in op) {
    return { not: rewriteWhereStrings(op.not as Expr) };
  }

  // Other expressions: leave as-is
  return expr;
}

function wrapIfString(expr: Expr): Expr {
  if (typeof expr === "string") {
    if (expr.startsWith("$.")) return parseDollarPath(expr);
    return { ref: expr };
  }
  return expr;
}

/**
 * Evaluate a `where` predicate against a collection entry.
 *
 * The entry's fields are added to a copy of `scope.bindings` so they are
 * accessible as `{ref: "fieldName"}` within the predicate.
 * Bare strings in operator positions are automatically rewritten to `{ref: ...}`.
 *
 * @param evaluator — injected to avoid circular imports (pass `evaluate` from evaluate.ts)
 */
export function matchesWhere(
  entry: unknown,
  predicate: Record<string, unknown>,
  scope: Scope,
  evaluator: EvaluatorFn,
  builtins?: BuiltinRegistry,
): boolean {
  // Build an extended scope with entry fields injected as bindings
  const entryBindings: Record<string, unknown> =
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? { ...(entry as Record<string, unknown>) }
      : {};

  const innerScope: Scope = {
    ...scope,
    bindings: { ...scope.bindings, ...entryBindings },
  };

  // Rewrite bare strings to refs, then evaluate
  const rewritten = rewriteWhereStrings(predicate);
  return Boolean(evaluator(rewritten, innerScope, builtins));
}
