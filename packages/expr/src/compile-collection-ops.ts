import type { Expr, Scope, BuiltinRegistry, CompiledExpr } from "./types.js";

type CompileFn = (expr: Expr, builtins?: BuiltinRegistry) => CompiledExpr;

// ─── Iteration operators ─────────────────────────────────────────────────────

export type IterOp = "filter" | "map" | "every" | "some" | "mapVals" | "filterKeys";

export function compileIteration(kind: IterOp, args: unknown[], cc: CompileFn, builtins?: BuiltinRegistry): CompiledExpr {
  const isEager = args.length === 3 && typeof args[1] === "string";
  const cArr = isEager ? cc(args[0] as Expr, builtins) : undefined;
  const bindName = isEager ? (args[1] as string) : (args[0] as string);
  const cBody = cc((isEager ? args[2] : args[1]) as Expr, builtins);
  if (kind === "mapVals" || kind === "filterKeys") {
    return (s) => {
      const o = isEager ? cArr!(s) : s.bindings.$;
      if (o === null || typeof o !== "object" || Array.isArray(o)) return {};
      const r: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        const inner = { ...s, bindings: { ...s.bindings, [bindName]: v, $key: k } };
        if (kind === "mapVals") r[k] = cBody(inner);
        else if (Boolean(cBody(inner))) r[k] = v;
      }
      return r;
    };
  }
  const nonArrayVal = kind === "every" ? false : kind === "some" ? false : [];
  return (s) => {
    const arr = isEager ? cArr!(s) : s.bindings.$;
    if (!Array.isArray(arr)) return nonArrayVal;
    const a = arr as unknown[];
    const makeInner = (item: unknown, i: number): Scope => ({
      ...s, bindings: { ...s.bindings, [bindName]: item, $index: i },
    });
    switch (kind) {
      case "filter": return a.filter((item, i) => Boolean(cBody(makeInner(item, i))));
      case "map": return a.map((item, i) => cBody(makeInner(item, i)));
      case "every": return a.every((item, i) => Boolean(cBody(makeInner(item, i))));
      case "some": return a.some((item, i) => Boolean(cBody(makeInner(item, i))));
    }
  };
}

// ─── Reduce ──────────────────────────────────────────────────────────────────

export function compileReduce(args: unknown[], cc: CompileFn, builtins?: BuiltinRegistry): CompiledExpr {
  const isTransducer = typeof args[0] === "string";
  const cArr = isTransducer ? undefined : cc(args[0] as Expr, builtins);
  const accName = isTransducer ? (args[0] as string) : (args[1] as string);
  const itemName = isTransducer ? (args[1] as string) : (args[2] as string);
  const cBody = cc((isTransducer ? args[2] : args[3]) as Expr, builtins);
  const hasInit = isTransducer ? args.length >= 4 : args.length >= 5;
  const cInit = hasInit ? cc((isTransducer ? args[3] : args[4]) as Expr, builtins) : undefined;

  return (s) => {
    const arr = isTransducer ? s.bindings.$ : cArr!(s);
    if (!Array.isArray(arr)) return hasInit ? cInit!(s) : undefined;
    const a = arr as unknown[];
    if (a.length === 0) return hasInit ? cInit!(s) : undefined;
    let acc: unknown;
    let startIdx: number;
    if (hasInit) { acc = cInit!(s); startIdx = 0; }
    else { acc = a[0]; startIdx = 1; }
    for (let i = startIdx; i < a.length; i++) {
      const inner: Scope = { ...s, bindings: { ...s.bindings, [accName]: acc, [itemName]: a[i], $index: i } };
      acc = cBody(inner);
    }
    return acc;
  };
}

// ─── Deep select ─────────────────────────────────────────────────────────────

export function compileDeepSelect(args: unknown[], cc: CompileFn, builtins?: BuiltinRegistry): CompiledExpr {
  const isEager = args.length === 3 && typeof args[1] === "string";
  const cSource = isEager ? cc(args[0] as Expr, builtins) : undefined;
  const bindName = isEager ? (args[1] as string) : (args[0] as string);
  const cBody = cc((isEager ? args[2] : args[1]) as Expr, builtins);
  return (s) => {
    const source = isEager ? cSource!(s) : s.bindings.$;
    const results: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Boolean(cBody({ ...s, bindings: { ...s.bindings, [bindName]: node } }))) results.push(node);
      if (Array.isArray(node)) { for (const item of node) walk(item); }
      else if (node !== null && typeof node === "object") {
        for (const val of Object.values(node as Record<string, unknown>)) walk(val);
      }
    };
    walk(source);
    return results;
  };
}

// ─── Cond path ───────────────────────────────────────────────────────────────

export function compileCondPath(args: unknown[], cc: CompileFn, builtins?: BuiltinRegistry): CompiledExpr {
  const cInput = cc(args[0] as Expr, builtins);
  const branches = (args.slice(1) as [Expr, Expr][]).map(([g, v]) => [cc(g, builtins), cc(v, builtins)] as const);
  return (s) => {
    const inner: Scope = { ...s, bindings: { ...s.bindings, $: cInput(s) } };
    for (const [g, v] of branches) { if (g(inner)) return v(inner); }
    return undefined;
  };
}
