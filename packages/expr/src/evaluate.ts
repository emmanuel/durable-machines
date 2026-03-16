import type { Expr, Scope, BuiltinRegistry } from "./types.js";

export function evaluate(
  expr: Expr,
  scope: Scope,
  builtins?: BuiltinRegistry,
): unknown {
  if (expr === null || expr === undefined) return expr;
  if (typeof expr === "string" || typeof expr === "number" || typeof expr === "boolean") return expr;
  return expr;
}
