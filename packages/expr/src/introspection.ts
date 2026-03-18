/**
 * Set of recognized expr operator keys.
 * Must stay in sync with `compile.ts`.
 */
const EXPR_OPERATORS = new Set([
  "select", "eq", "neq", "gt", "lt", "gte", "lte",
  "and", "or", "not", "if", "cond",
  "in", "ref", "param", "let",
  "coalesce", "isNull",
  "add", "sub", "mul", "div",
  "object", "len", "at", "merge", "concat",
  "filter", "map", "every", "some", "reduce", "mapVals", "filterKeys", "deepSelect",
  "pipe", "pick", "prepend", "multiSelect", "condPath",
  "fn",
]);

/**
 * Returns `true` if `value` is a plain object with at least one recognized
 * expr operator key.
 */
export function isExprOperator(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (EXPR_OPERATORS.has(key)) return true;
  }
  return false;
}
