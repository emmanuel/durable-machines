import type { Expr, Scope, BuiltinRegistry } from "./types.js";

type EvalFn = (expr: Expr, scope: Scope, builtins?: BuiltinRegistry) => unknown;

// ─── Dual-arity helpers ──────────────────────────────────────────────────────

type IterOp = "filter" | "map" | "every" | "some";

function parseDualArity(
  args: unknown[],
  scope: Scope,
  ev: EvalFn,
  builtins?: BuiltinRegistry,
): { arr: unknown; bindName: string; body: Expr } {
  if (args.length === 3 && typeof args[1] === "string") {
    return {
      arr: ev(args[0] as Expr, scope, builtins),
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

function parseObjectDualArity(
  args: unknown[],
  scope: Scope,
  ev: EvalFn,
  builtins?: BuiltinRegistry,
): { obj: unknown; bindName: string; body: Expr } {
  if (args.length === 3 && typeof args[1] === "string") {
    return { obj: ev(args[0] as Expr, scope, builtins), bindName: args[1], body: args[2] as Expr };
  }
  return { obj: scope.bindings.$, bindName: args[0] as string, body: args[1] as Expr };
}

// ─── Array iteration ─────────────────────────────────────────────────────────

export function evaluateIteration(
  kind: IterOp,
  args: unknown[],
  scope: Scope,
  ev: EvalFn,
  builtins?: BuiltinRegistry,
): unknown {
  const { arr, bindName, body } = parseDualArity(args, scope, ev, builtins);

  if (!Array.isArray(arr)) {
    return kind === "every" ? false : kind === "some" ? false : [];
  }

  const makeInner = (item: unknown, i: number): Scope => ({
    ...scope, bindings: { ...scope.bindings, [bindName]: item, $index: i },
  });

  switch (kind) {
    case "filter":
      return arr.filter((item, i) => Boolean(ev(body, makeInner(item, i), builtins)));
    case "map":
      return arr.map((item, i) => ev(body, makeInner(item, i), builtins));
    case "every":
      return arr.every((item, i) => Boolean(ev(body, makeInner(item, i), builtins)));
    case "some":
      return arr.some((item, i) => Boolean(ev(body, makeInner(item, i), builtins)));
  }
}

// ─── Reduce ──────────────────────────────────────────────────────────────────

export function evaluateReduce(args: unknown[], scope: Scope, ev: EvalFn, builtins?: BuiltinRegistry): unknown {
  let arr: unknown;
  let accName: string;
  let itemName: string;
  let body: Expr;
  let hasInit: boolean;
  let init: Expr | undefined;

  if (typeof args[0] === "string") {
    arr = scope.bindings.$;
    accName = args[0] as string;
    itemName = args[1] as string;
    body = args[2] as Expr;
    hasInit = args.length >= 4;
    init = hasInit ? (args[3] as Expr) : undefined;
  } else {
    arr = ev(args[0] as Expr, scope, builtins);
    accName = args[1] as string;
    itemName = args[2] as string;
    body = args[3] as Expr;
    hasInit = args.length >= 5;
    init = hasInit ? (args[4] as Expr) : undefined;
  }

  if (!Array.isArray(arr)) {
    return hasInit ? ev(init!, scope, builtins) : undefined;
  }
  const a = arr as unknown[];
  if (a.length === 0) {
    return hasInit ? ev(init!, scope, builtins) : undefined;
  }

  let acc: unknown;
  let startIdx: number;
  if (hasInit) {
    acc = ev(init!, scope, builtins);
    startIdx = 0;
  } else {
    acc = a[0];
    startIdx = 1;
  }

  for (let i = startIdx; i < a.length; i++) {
    const inner: Scope = { ...scope, bindings: {
      ...scope.bindings, [accName]: acc, [itemName]: a[i], $index: i,
    }};
    acc = ev(body, inner, builtins);
  }
  return acc;
}

// ─── Object iteration (mapVals, filterKeys) ──────────────────────────────────

export function evaluateMapVals(args: unknown[], scope: Scope, ev: EvalFn, builtins?: BuiltinRegistry): unknown {
  const { obj, bindName, body } = parseObjectDualArity(args, scope, ev, builtins);
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const inner: Scope = { ...scope, bindings: { ...scope.bindings, [bindName]: val, $key: key } };
    result[key] = ev(body, inner, builtins);
  }
  return result;
}

export function evaluateFilterKeys(args: unknown[], scope: Scope, ev: EvalFn, builtins?: BuiltinRegistry): unknown {
  const { obj, bindName, body } = parseObjectDualArity(args, scope, ev, builtins);
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const inner: Scope = { ...scope, bindings: { ...scope.bindings, [bindName]: val, $key: key } };
    if (Boolean(ev(body, inner, builtins))) result[key] = val;
  }
  return result;
}

// ─── Deep select ─────────────────────────────────────────────────────────────

export function evaluateDeepSelect(args: unknown[], scope: Scope, ev: EvalFn, builtins?: BuiltinRegistry): unknown {
  let source: unknown; let bindName: string; let body: Expr;
  if (args.length === 3 && typeof args[1] === "string") {
    source = ev(args[0] as Expr, scope, builtins); bindName = args[1]; body = args[2] as Expr;
  } else {
    source = scope.bindings.$; bindName = args[0] as string; body = args[1] as Expr;
  }
  const results: unknown[] = [];
  const walk = (node: unknown): void => {
    const inner: Scope = { ...scope, bindings: { ...scope.bindings, [bindName]: node } };
    if (Boolean(ev(body, inner, builtins))) results.push(node);
    if (Array.isArray(node)) { for (const item of node) walk(item); }
    else if (node !== null && typeof node === "object") {
      for (const val of Object.values(node as Record<string, unknown>)) walk(val);
    }
  };
  walk(source);
  return results;
}

// ─── Pipe ────────────────────────────────────────────────────────────────────

export function evaluatePipe(steps: Expr[], scope: Scope, ev: EvalFn, builtins?: BuiltinRegistry): unknown {
  if (steps.length === 0) return undefined;
  let current = ev(steps[0], scope, builtins);
  for (let i = 1; i < steps.length; i++) {
    const inner: Scope = { ...scope, bindings: { ...scope.bindings, $: current } };
    current = ev(steps[i], inner, builtins);
  }
  return current;
}
