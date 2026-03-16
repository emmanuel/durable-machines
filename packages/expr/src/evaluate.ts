import type { Expr, Scope, BuiltinRegistry, Path } from "./types.js";
import { selectPath } from "./path.js";

export function evaluate(
  expr: Expr,
  scope: Scope,
  builtins?: BuiltinRegistry,
): unknown {
  // Literals
  if (expr === null || expr === undefined) return expr;
  if (typeof expr === "string" || typeof expr === "number" || typeof expr === "boolean") return expr;

  // Arrays are not operator expressions — return as-is (they may be literal arrays in `in` operands)
  if (Array.isArray(expr)) return expr;

  // Operator dispatch
  if (typeof expr === "object") {
    const op = expr as Record<string, unknown>;

    // select — path navigation
    if ("select" in op) {
      return selectPath(op.select as Path, scope);
    }

    // Comparisons — [left, right]
    if ("eq" in op) {
      const [a, b] = op.eq as [Expr, Expr];
      return evaluate(a, scope, builtins) === evaluate(b, scope, builtins);
    }
    if ("neq" in op) {
      const [a, b] = op.neq as [Expr, Expr];
      return evaluate(a, scope, builtins) !== evaluate(b, scope, builtins);
    }
    if ("gt" in op) {
      const [a, b] = op.gt as [Expr, Expr];
      return (evaluate(a, scope, builtins) as number) > (evaluate(b, scope, builtins) as number);
    }
    if ("lt" in op) {
      const [a, b] = op.lt as [Expr, Expr];
      return (evaluate(a, scope, builtins) as number) < (evaluate(b, scope, builtins) as number);
    }
    if ("gte" in op) {
      const [a, b] = op.gte as [Expr, Expr];
      return (evaluate(a, scope, builtins) as number) >= (evaluate(b, scope, builtins) as number);
    }
    if ("lte" in op) {
      const [a, b] = op.lte as [Expr, Expr];
      return (evaluate(a, scope, builtins) as number) <= (evaluate(b, scope, builtins) as number);
    }

    // Logic
    if ("and" in op) {
      const exprs = op.and as Expr[];
      return exprs.every((e) => Boolean(evaluate(e, scope, builtins)));
    }
    if ("or" in op) {
      const exprs = op.or as Expr[];
      return exprs.some((e) => Boolean(evaluate(e, scope, builtins)));
    }
    if ("not" in op) {
      return !evaluate(op.not as Expr, scope, builtins);
    }
    if ("if" in op) {
      const [cond, then, els] = op.if as [Expr, Expr, Expr];
      return evaluate(cond, scope, builtins) ? evaluate(then, scope, builtins) : evaluate(els, scope, builtins);
    }
    if ("cond" in op) {
      const branches = op.cond as [Expr, Expr][];
      for (const [guard, value] of branches) {
        if (evaluate(guard, scope, builtins)) {
          return evaluate(value, scope, builtins);
        }
      }
      return undefined;
    }

    // Membership
    if ("in" in op) {
      const [value, array] = op.in as [Expr, Expr];
      const evaluatedValue = evaluate(value, scope, builtins);
      const evaluatedArray = evaluate(array, scope, builtins);
      if (!Array.isArray(evaluatedArray)) return false;
      return evaluatedArray.includes(evaluatedValue);
    }

    // Bindings — ref and param
    if ("ref" in op) {
      return scope.bindings[op.ref as string];
    }
    if ("param" in op) {
      return scope.params[op.param as string];
    }

    // let — evaluate bindings in order, then evaluate body in extended scope
    if ("let" in op) {
      const letBindings = op.let as Record<string, Expr>;
      const body = op.body as Expr;
      const extendedBindings = { ...scope.bindings };
      const innerScope: Scope = { ...scope, bindings: extendedBindings };
      for (const [key, bindingExpr] of Object.entries(letBindings)) {
        extendedBindings[key] = evaluate(bindingExpr, innerScope, builtins);
      }
      return evaluate(body, innerScope, builtins);
    }

    // Nullability
    if ("coalesce" in op) {
      const exprs = op.coalesce as Expr[];
      for (const e of exprs) {
        const val = evaluate(e, scope, builtins);
        if (val != null) return val;
      }
      return undefined;
    }
    if ("isNull" in op) {
      return evaluate(op.isNull as Expr, scope, builtins) == null;
    }

    // Arithmetic
    if ("add" in op) {
      const [a, b] = op.add as [Expr, Expr];
      return (evaluate(a, scope, builtins) as number) + (evaluate(b, scope, builtins) as number);
    }
    if ("sub" in op) {
      const [a, b] = op.sub as [Expr, Expr];
      return (evaluate(a, scope, builtins) as number) - (evaluate(b, scope, builtins) as number);
    }
    if ("mul" in op) {
      const [a, b] = op.mul as [Expr, Expr];
      return (evaluate(a, scope, builtins) as number) * (evaluate(b, scope, builtins) as number);
    }
    if ("div" in op) {
      const [a, b] = op.div as [Expr, Expr];
      return (evaluate(a, scope, builtins) as number) / (evaluate(b, scope, builtins) as number);
    }

    // Object construction
    if ("object" in op) {
      const fields = op.object as Record<string, Expr>;
      const result: Record<string, unknown> = {};
      for (const [key, valExpr] of Object.entries(fields)) {
        result[key] = evaluate(valExpr, scope, builtins);
      }
      return result;
    }
  }

  return expr;
}
