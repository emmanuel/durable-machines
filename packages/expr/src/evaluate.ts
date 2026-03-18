import type { Expr, Scope, BuiltinRegistry, Path, PathNavigator } from "./types.js";
import { matchesWhere } from "./where.js";

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
  if (typeof expr === "string" || typeof expr === "number" || typeof expr === "boolean") return expr;
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

  // Iteration operators
  if ("filter" in op) return evaluateIteration("filter", op.filter as unknown[], scope, builtins);
  if ("map" in op) return evaluateIteration("map", op.map as unknown[], scope, builtins);
  if ("every" in op) return evaluateIteration("every", op.every as unknown[], scope, builtins);
  if ("some" in op) return evaluateIteration("some", op.some as unknown[], scope, builtins);
  if ("reduce" in op) return evaluateReduce(op.reduce as unknown[], scope, builtins);

  // pipe — sequential composition with $ binding
  if ("pipe" in op) return evaluatePipe(op.pipe as Expr[], scope, builtins);

  // fn — call a registered builtin
  if ("fn" in op) {
    const [name, ...argExprs] = op.fn as [string, ...Expr[]];
    const fn = builtins?.[name];
    return fn ? fn(...argExprs.map(ev)) : undefined;
  }

  return expr;
}

// ─── Iteration helpers ────────────────────────────────────────────────────────

type IterOp = "filter" | "map" | "every" | "some";

function parseDualArity(
  args: unknown[],
  scope: Scope,
  builtins?: BuiltinRegistry,
): { arr: unknown; bindName: string; body: Expr } {
  if (args.length === 3 && typeof args[1] === "string") {
    return {
      arr: evaluate(args[0] as Expr, scope, builtins),
      bindName: args[1],
      body: args[2] as Expr,
    };
  }
  return {
    arr: scope.bindings.$,
    bindName: args[0] as string,
    body: args[1] as Expr,
  };
}

function evaluateIteration(
  kind: IterOp,
  args: unknown[],
  scope: Scope,
  builtins?: BuiltinRegistry,
): unknown {
  const { arr, bindName, body } = parseDualArity(args, scope, builtins);

  if (!Array.isArray(arr)) {
    return kind === "every" ? false : kind === "some" ? false : [];
  }

  const makeInner = (item: unknown, i: number): Scope => ({
    ...scope, bindings: { ...scope.bindings, [bindName]: item, $index: i },
  });

  switch (kind) {
    case "filter":
      return arr.filter((item, i) => Boolean(evaluate(body, makeInner(item, i), builtins)));
    case "map":
      return arr.map((item, i) => evaluate(body, makeInner(item, i), builtins));
    case "every":
      return arr.every((item, i) => Boolean(evaluate(body, makeInner(item, i), builtins)));
    case "some":
      return arr.some((item, i) => Boolean(evaluate(body, makeInner(item, i), builtins)));
  }
}

function evaluateReduce(args: unknown[], scope: Scope, builtins?: BuiltinRegistry): unknown {
  let arr: unknown;
  let accName: string;
  let itemName: string;
  let body: Expr;
  let hasInit: boolean;
  let init: Expr | undefined;

  if (typeof args[0] === "string") {
    // Transducer: ["acc", "item", body] or ["acc", "item", body, init]
    arr = scope.bindings.$;
    accName = args[0] as string;
    itemName = args[1] as string;
    body = args[2] as Expr;
    hasInit = args.length >= 4;
    init = hasInit ? (args[3] as Expr) : undefined;
  } else {
    // Eager: [arr, "acc", "item", body] or [arr, "acc", "item", body, init]
    arr = evaluate(args[0] as Expr, scope, builtins);
    accName = args[1] as string;
    itemName = args[2] as string;
    body = args[3] as Expr;
    hasInit = args.length >= 5;
    init = hasInit ? (args[4] as Expr) : undefined;
  }

  if (!Array.isArray(arr)) {
    return hasInit ? evaluate(init!, scope, builtins) : undefined;
  }
  const a = arr as unknown[];
  if (a.length === 0) {
    return hasInit ? evaluate(init!, scope, builtins) : undefined;
  }

  let acc: unknown;
  let startIdx: number;
  if (hasInit) {
    acc = evaluate(init!, scope, builtins);
    startIdx = 0;
  } else {
    acc = a[0];
    startIdx = 1;
  }

  for (let i = startIdx; i < a.length; i++) {
    const inner: Scope = { ...scope, bindings: {
      ...scope.bindings, [accName]: acc, [itemName]: a[i], $index: i,
    }};
    acc = evaluate(body, inner, builtins);
  }
  return acc;
}

function evaluatePipe(steps: Expr[], scope: Scope, builtins?: BuiltinRegistry): unknown {
  if (steps.length === 0) return undefined;
  let current = evaluate(steps[0], scope, builtins);
  for (let i = 1; i < steps.length; i++) {
    const inner: Scope = { ...scope, bindings: { ...scope.bindings, $: current } };
    current = evaluate(steps[i], inner, builtins);
  }
  return current;
}
