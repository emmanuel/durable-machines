import type { Expr, Scope, BuiltinRegistry, Path, PathNavigator } from "./types.js";
import { matchesWhere } from "./where.js";
import {
  evaluateIteration, evaluateReduce, evaluateMapVals,
  evaluateFilterKeys, evaluateDeepSelect, evaluatePipe,
} from "./eval-collection-ops.js";
import { parseDollarPath } from "./desugar.js";

// ─── Path navigation ─────────────────────────────────────────────────────────

/**
 * Navigate a path against the scope and return the value at the path.
 * Returns `undefined` for missing or non-navigable paths.
 */
export function selectPath(path: Path, scope: Scope, builtins?: BuiltinRegistry): unknown {
  if (path.length === 0) return undefined;

  const [root, ...rest] = path;

  // Root must be a string
  if (typeof root !== "string") return undefined;

  // Resolve the root value
  let current: unknown;
  if (root === "context") {
    current = scope.context;
  } else if (root === "event") {
    current = scope.event;
  } else if (root === "params") {
    current = scope.params;
  } else if (root in scope.bindings) {
    current = scope.bindings[root];
  } else {
    return undefined;
  }

  // Navigate the remaining steps
  for (const step of rest) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;

    // Handle `where` navigator — filter collection entries
    if (typeof step === "object" && "where" in step) {
      const predicate = step.where as Record<string, unknown>;
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
        if (matchesWhere(value, predicate, scope, evaluate, builtins)) {
          filtered[key] = value;
        }
      }
      current = filtered;
      continue;
    }

    const key = resolveStep(step, scope, builtins);
    if (key === undefined) return undefined;

    current = (current as Record<string, unknown>)[String(key)];
  }

  return current;
}

/**
 * Resolve a PathNavigator step to a concrete key string.
 *
 * Handles static keys, `{param}`, `{ref}`, and arbitrary expression objects
 * (e.g. `{select: ["event", "sessionId"]}`) which are evaluated and coerced
 * to a string key.
 */
export function resolveStep(
  step: PathNavigator,
  scope: Scope,
  builtins?: BuiltinRegistry,
): string | undefined {
  if (typeof step === "string") {
    return step;
  }
  if ("param" in step && typeof (step as { param: string }).param === "string") {
    const paramVal = scope.params[(step as { param: string }).param];
    return paramVal !== undefined ? String(paramVal) : undefined;
  }
  if ("ref" in step && typeof (step as { ref: string }).ref === "string") {
    const refVal = scope.bindings[(step as { ref: string }).ref];
    return refVal !== undefined ? String(refVal) : undefined;
  }
  // `where`, `all`, `first`, `last` are collection navigators — not resolvable to a single key
  if (typeof step === "object" && step !== null) {
    if ("where" in step || "all" in step || "first" in step || "last" in step) {
      return undefined;
    }
    // Arbitrary expression object — evaluate and coerce to string key
    const evaluated = evaluate(step as Expr, scope, builtins);
    return evaluated !== undefined && evaluated !== null ? String(evaluated) : undefined;
  }
  return undefined;
}

// ─── Evaluator ───────────────────────────────────────────────────────────────

export function evaluate(expr: Expr, scope: Scope, builtins?: BuiltinRegistry): unknown {
  // Literals
  if (expr === null || expr === undefined) return expr;
  if (typeof expr === "string") {
    if (expr.startsWith("$.")) return evaluate(parseDollarPath(expr), scope, builtins);
    return expr;
  }
  if (typeof expr === "number" || typeof expr === "boolean") return expr;
  if (Array.isArray(expr)) return expr;

  // Operator dispatch
  if (typeof expr !== "object") return expr;
  const op = expr as Record<string, unknown>;

  const ev = (e: Expr) => evaluate(e, scope, builtins);
  const n = (e: Expr) => ev(e) as number;

  // select
  if ("select" in op) return selectPath(op.select as Path, scope, builtins);

  // Comparisons
  if ("eq" in op) { const [a, b] = op.eq as [Expr, Expr]; return ev(a) === ev(b); }
  if ("neq" in op) { const [a, b] = op.neq as [Expr, Expr]; return ev(a) !== ev(b); }
  if ("gt" in op) { const [a, b] = op.gt as [Expr, Expr]; return n(a) > n(b); }
  if ("lt" in op) { const [a, b] = op.lt as [Expr, Expr]; return n(a) < n(b); }
  if ("gte" in op) { const [a, b] = op.gte as [Expr, Expr]; return n(a) >= n(b); }
  if ("lte" in op) { const [a, b] = op.lte as [Expr, Expr]; return n(a) <= n(b); }

  // Logic
  if ("and" in op) return (op.and as Expr[]).every((e) => Boolean(ev(e)));
  if ("or" in op) return (op.or as Expr[]).some((e) => Boolean(ev(e)));
  if ("not" in op) return !ev(op.not as Expr);
  if ("if" in op) { const [cond, then, els] = op.if as [Expr, Expr, Expr]; return ev(cond) ? ev(then) : ev(els); }
  if ("cond" in op) {
    for (const [guard, value] of op.cond as [Expr, Expr][]) {
      if (ev(guard)) return ev(value);
    }
    return undefined;
  }

  // Membership
  if ("in" in op) {
    const [value, array] = op.in as [Expr, Expr];
    const arr = ev(array);
    return Array.isArray(arr) ? arr.includes(ev(value)) : false;
  }

  // Bindings
  if ("ref" in op) return scope.bindings[op.ref as string];
  if ("param" in op) return scope.params[op.param as string];

  // let
  if ("let" in op) {
    const [bindingsExpr, body] = op.let as [Record<string, Expr>, Expr];
    const extendedBindings = { ...scope.bindings };
    const innerScope: Scope = { ...scope, bindings: extendedBindings };
    for (const [key, bindingExpr] of Object.entries(bindingsExpr)) {
      extendedBindings[key] = evaluate(bindingExpr, innerScope, builtins);
    }
    return evaluate(body, innerScope, builtins);
  }

  // Nullability
  if ("coalesce" in op) {
    for (const e of op.coalesce as Expr[]) { const v = ev(e); if (v != null) return v; }
    return undefined;
  }
  if ("isNull" in op) return ev(op.isNull as Expr) == null;

  // Arithmetic
  if ("add" in op) { const [a, b] = op.add as [Expr, Expr]; return n(a) + n(b); }
  if ("sub" in op) { const [a, b] = op.sub as [Expr, Expr]; return n(a) - n(b); }
  if ("mul" in op) { const [a, b] = op.mul as [Expr, Expr]; return n(a) * n(b); }
  if ("div" in op) { const [a, b] = op.div as [Expr, Expr]; return n(a) / n(b); }

  // Object construction
  if ("object" in op) {
    const result: Record<string, unknown> = {};
    for (const [key, valExpr] of Object.entries(op.object as Record<string, Expr>)) {
      result[key] = ev(valExpr);
    }
    return result;
  }

  // len
  if ("len" in op) {
    const val = ev(op.len as Expr);
    if (Array.isArray(val) || typeof val === "string") return val.length;
    if (val !== null && typeof val === "object") return Object.keys(val).length;
    return 0;
  }

  // at
  if ("at" in op) {
    const [arrExpr, idxExpr] = op.at as [Expr, Expr];
    const arr = ev(arrExpr);
    return Array.isArray(arr) ? (arr as unknown[]).at(n(idxExpr)) : undefined;
  }

  // merge
  if ("merge" in op) {
    const result: Record<string, unknown> = {};
    for (const e of op.merge as Expr[]) {
      const val = ev(e);
      if (val !== null && typeof val === "object" && !Array.isArray(val)) Object.assign(result, val);
    }
    return result;
  }

  // concat — array concatenation (n-ary, non-arrays become single elements)
  if ("concat" in op) {
    const result: unknown[] = [];
    for (const e of op.concat as Expr[]) {
      const val = ev(e);
      if (Array.isArray(val)) result.push(...val);
      else result.push(val);
    }
    return result;
  }

  // Iteration operators (delegated to eval-collection-ops)
  if ("filter" in op) return evaluateIteration("filter", op.filter as unknown[], scope, evaluate, builtins);
  if ("map" in op) return evaluateIteration("map", op.map as unknown[], scope, evaluate, builtins);
  if ("every" in op) return evaluateIteration("every", op.every as unknown[], scope, evaluate, builtins);
  if ("some" in op) return evaluateIteration("some", op.some as unknown[], scope, evaluate, builtins);
  if ("reduce" in op) return evaluateReduce(op.reduce as unknown[], scope, evaluate, builtins);
  if ("mapVals" in op) return evaluateMapVals(op.mapVals as unknown[], scope, evaluate, builtins);
  if ("filterKeys" in op) return evaluateFilterKeys(op.filterKeys as unknown[], scope, evaluate, builtins);
  if ("deepSelect" in op) return evaluateDeepSelect(op.deepSelect as unknown[], scope, evaluate, builtins);
  if ("pipe" in op) return evaluatePipe(op.pipe as Expr[], scope, evaluate, builtins);

  // Simple operators
  if ("pick" in op) {
    const [objExpr, keysExpr] = op.pick as [Expr, Expr];
    const obj = ev(objExpr); const keys = ev(keysExpr);
    if (obj === null || typeof obj !== "object" || Array.isArray(obj) || !Array.isArray(keys)) return {};
    const r: Record<string, unknown> = {};
    for (const k of keys as string[]) { if (k in (obj as Record<string, unknown>)) r[k] = (obj as Record<string, unknown>)[k]; }
    return r;
  }
  if ("prepend" in op) {
    const [arrExpr, valExpr] = op.prepend as [Expr, Expr];
    const arr = ev(arrExpr); const val = ev(valExpr);
    return Array.isArray(arr) ? [val, ...arr] : [val];
  }
  if ("multiSelect" in op) return (op.multiSelect as Expr[]).map(ev);

  // condPath — bind input as $, evaluate guard/result pairs
  if ("condPath" in op) {
    const args = op.condPath as unknown[];
    const input = ev(args[0] as Expr);
    const inner: Scope = { ...scope, bindings: { ...scope.bindings, $: input } };
    for (const [guard, value] of args.slice(1) as [Expr, Expr][]) {
      if (evaluate(guard, inner, builtins)) return evaluate(value, inner, builtins);
    }
    return undefined;
  }

  // fn — call a registered builtin
  if ("fn" in op) {
    const [name, ...argExprs] = op.fn as [string, ...Expr[]];
    const fn = builtins?.[name];
    return fn ? fn(...argExprs.map(ev)) : undefined;
  }

  return expr;
}
