import type { Expr, Scope, BuiltinRegistry, Path, PathNavigator, CompiledExpr } from "./types.js";
import { rewriteWhereStrings } from "./where.js";

/**
 * Compile an expression tree into a closure.
 *
 * Walks the tree once at compile time — at runtime, only closures execute.
 * Builtins are captured by reference (impure ones like `uuid` still produce
 * fresh values per call).
 */
export function compile(expr: Expr, builtins?: BuiltinRegistry): CompiledExpr {
  // Literals
  if (expr === null || expr === undefined) return () => expr;
  if (typeof expr === "string" || typeof expr === "number" || typeof expr === "boolean") return () => expr;
  if (Array.isArray(expr)) return () => expr;

  if (typeof expr !== "object") return () => expr;

  const op = expr as Record<string, unknown>;

  // select — path navigation
  if ("select" in op) return compilePath(op.select as Path, builtins);

  // Comparisons
  if ("eq" in op) { const [ca, cb] = compilePair(op.eq as [Expr, Expr], builtins); return (s) => ca(s) === cb(s); }
  if ("neq" in op) { const [ca, cb] = compilePair(op.neq as [Expr, Expr], builtins); return (s) => ca(s) !== cb(s); }
  if ("gt" in op) { const [ca, cb] = compilePair(op.gt as [Expr, Expr], builtins); return (s) => (ca(s) as number) > (cb(s) as number); }
  if ("lt" in op) { const [ca, cb] = compilePair(op.lt as [Expr, Expr], builtins); return (s) => (ca(s) as number) < (cb(s) as number); }
  if ("gte" in op) { const [ca, cb] = compilePair(op.gte as [Expr, Expr], builtins); return (s) => (ca(s) as number) >= (cb(s) as number); }
  if ("lte" in op) { const [ca, cb] = compilePair(op.lte as [Expr, Expr], builtins); return (s) => (ca(s) as number) <= (cb(s) as number); }

  // Logic
  if ("and" in op) {
    const fns = (op.and as Expr[]).map(e => compile(e, builtins));
    return (s) => fns.every(f => Boolean(f(s)));
  }
  if ("or" in op) {
    const fns = (op.or as Expr[]).map(e => compile(e, builtins));
    return (s) => fns.some(f => Boolean(f(s)));
  }
  if ("not" in op) {
    const fn = compile(op.not as Expr, builtins);
    return (s) => !fn(s);
  }
  if ("if" in op) {
    const [cc, ct, ce] = (op.if as [Expr, Expr, Expr]).map(e => compile(e, builtins));
    return (s) => cc(s) ? ct(s) : ce(s);
  }
  if ("cond" in op) {
    const branches = (op.cond as [Expr, Expr][]).map(([g, v]) => [compile(g, builtins), compile(v, builtins)] as const);
    return (s) => {
      for (const [guard, value] of branches) {
        if (guard(s)) return value(s);
      }
      return undefined;
    };
  }

  // Membership
  if ("in" in op) {
    const [cv, ca] = compilePair(op.in as [Expr, Expr], builtins);
    return (s) => {
      const arr = ca(s);
      if (!Array.isArray(arr)) return false;
      return arr.includes(cv(s));
    };
  }

  // Bindings
  if ("ref" in op) { const name = op.ref as string; return (s) => s.bindings[name]; }
  if ("param" in op) { const name = op.param as string; return (s) => s.params[name]; }

  // let
  if ("let" in op) {
    const [bindingsExpr, bodyExpr] = op.let as [Record<string, Expr>, Expr];
    const letEntries = Object.entries(bindingsExpr).map(
      ([name, e]) => ({ name, fn: compile(e, builtins) }),
    );
    const body = compile(bodyExpr, builtins);
    return (s) => {
      const bindings = { ...s.bindings };
      const inner: Scope = { ...s, bindings };
      for (const { name, fn } of letEntries) {
        bindings[name] = fn(inner);
      }
      return body(inner);
    };
  }

  // Nullability
  if ("coalesce" in op) {
    const fns = (op.coalesce as Expr[]).map(e => compile(e, builtins));
    return (s) => {
      for (const f of fns) {
        const v = f(s);
        if (v != null) return v;
      }
      return undefined;
    };
  }
  if ("isNull" in op) {
    const fn = compile(op.isNull as Expr, builtins);
    return (s) => fn(s) == null;
  }

  // Arithmetic
  if ("add" in op) { const [ca, cb] = compilePair(op.add as [Expr, Expr], builtins); return (s) => (ca(s) as number) + (cb(s) as number); }
  if ("sub" in op) { const [ca, cb] = compilePair(op.sub as [Expr, Expr], builtins); return (s) => (ca(s) as number) - (cb(s) as number); }
  if ("mul" in op) { const [ca, cb] = compilePair(op.mul as [Expr, Expr], builtins); return (s) => (ca(s) as number) * (cb(s) as number); }
  if ("div" in op) { const [ca, cb] = compilePair(op.div as [Expr, Expr], builtins); return (s) => (ca(s) as number) / (cb(s) as number); }

  // Object construction
  if ("object" in op) {
    const fields = Object.entries(op.object as Record<string, Expr>).map(
      ([key, e]) => ({ key, fn: compile(e, builtins) }),
    );
    return (s) => {
      const result: Record<string, unknown> = {};
      for (const { key, fn } of fields) {
        result[key] = fn(s);
      }
      return result;
    };
  }

  // len — length of array/string/object
  if ("len" in op) {
    const fn = compile(op.len as Expr, builtins);
    return (s) => {
      const val = fn(s);
      if (Array.isArray(val)) return val.length;
      if (typeof val === "string") return val.length;
      if (val !== null && typeof val === "object") return Object.keys(val).length;
      return 0;
    };
  }

  // fn — builtin call
  if ("fn" in op) {
    const fnArgs = op.fn as [string, ...Expr[]];
    const [name, ...argExprs] = fnArgs;
    const fn = builtins?.[name];
    if (!fn) return () => undefined;
    const argFns = argExprs.map(a => compile(a, builtins));
    return (s) => fn(...argFns.map(f => f(s)));
  }

  return () => expr;
}

// ─── Path compilation ─────────────────────────────────────────────────────────

type CompiledPathStep = (current: Record<string, unknown>, scope: Scope) => unknown;

function compilePath(path: Path, builtins?: BuiltinRegistry): CompiledExpr {
  if (path.length === 0) return () => undefined;
  const [root, ...rest] = path;
  if (typeof root !== "string") return () => undefined;

  const steps = rest.map(step => compilePathStep(step, builtins));

  return (scope) => {
    let current: unknown;
    if (root === "context") current = scope.context;
    else if (root === "event") current = scope.event;
    else if (root === "params") current = scope.params;
    else if (root in scope.bindings) current = scope.bindings[root];
    else return undefined;

    for (const step of steps) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== "object") return undefined;
      current = step(current as Record<string, unknown>, scope);
    }
    return current;
  };
}

function compilePathStep(step: PathNavigator, builtins?: BuiltinRegistry): CompiledPathStep {
  // Static key
  if (typeof step === "string") return (current) => current[step];

  // param
  if ("param" in step && typeof (step as { param: string }).param === "string") {
    const name = (step as { param: string }).param;
    return (current, scope) => {
      const key = scope.params[name];
      return key !== undefined ? current[String(key)] : undefined;
    };
  }

  // ref
  if ("ref" in step && typeof (step as { ref: string }).ref === "string") {
    const name = (step as { ref: string }).ref;
    return (current, scope) => {
      const key = scope.bindings[name];
      return key !== undefined ? current[String(key)] : undefined;
    };
  }

  // where — pre-process predicate at compile time
  if (typeof step === "object" && step !== null && "where" in step) {
    const predicate = step.where as Record<string, unknown>;
    const rewritten = rewriteWhereStrings(predicate);
    const compiledPred = compile(rewritten as Expr, builtins);
    return (current, scope) => {
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(current)) {
        const entryBindings =
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? { ...(value as Record<string, unknown>) }
            : {};
        const innerScope: Scope = { ...scope, bindings: { ...scope.bindings, ...entryBindings } };
        if (compiledPred(innerScope)) {
          filtered[key] = value;
        }
      }
      return filtered;
    };
  }

  // Collection navigators — not resolvable
  if (typeof step === "object" && step !== null) {
    if ("all" in step || "first" in step || "last" in step) return () => undefined;

    // Arbitrary expression
    const compiledExpr = compile(step as Expr, builtins);
    return (current, scope) => {
      const key = compiledExpr(scope);
      return key !== undefined && key !== null ? current[String(key)] : undefined;
    };
  }

  return () => undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function compilePair(pair: [Expr, Expr], builtins?: BuiltinRegistry): [CompiledExpr, CompiledExpr] {
  return [compile(pair[0], builtins), compile(pair[1], builtins)];
}
