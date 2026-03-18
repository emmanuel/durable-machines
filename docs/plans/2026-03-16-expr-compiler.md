# Expression Compiler + Machine Definition Integration

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile JSON expression trees into closures at machine registration time, and wire them into `createMachineFromDefinition` so guards and actions can be expressed as data (no JS required).

**Architecture:** `compile(expr, builtins)` walks the expression tree once and produces a closure tree — no operator dispatch at runtime. Guard/action expr bodies are declared as named definitions on `MachineDefinition.guards` / `.actions`. At `createMachineFromDefinition` time, each named expr is compiled, wrapped as an XState-compatible function, and passed to `setup()`. XState's native `params` mechanism threads static transition params into `scope.params`.

**Tech Stack:** TypeScript, XState v5, vitest, pnpm monorepo

---

## File Structure

### `packages/expr/` (new files)

| File | Responsibility |
|------|----------------|
| `src/compile.ts` | Core compiler: `compile(expr, builtins?) → CompiledExpr`. Handles all ~25 operators. |
| `src/compile-actions.ts` | `compileGuard(expr, builtins?)` and `compileAction(actionDef, builtins?)`. Pre-compiles let bindings, guard conditions, event payloads. Delegates transform application to `applyTransforms`. |
| `tests/unit/compile.test.ts` | Expression compiler tests — one per operator, plus equivalence with `evaluate()`. |
| `tests/unit/compile-actions.test.ts` | Guard/action compiler tests — paper prototype fixtures. |

### `packages/expr/` (modified files)

| File | Change |
|------|--------|
| `src/actions.ts` | Fix `evaluateEnqueue` to chain context between sequential assigns. |
| `src/types.ts` | Add `CompiledExpr`, `CompiledGuard`, `CompiledAction` types. |
| `src/index.ts` | Export new functions and types. |

### `packages/durable-machine/` (modified files)

| File | Change |
|------|--------|
| `src/definition/types.ts` | Add `guards?: Record<string, Expr>` and `actions?: Record<string, ActionDef>` to `MachineDefinition`. Add optional `builtins` to a new options type. |
| `src/definition/validate-definition.ts` | Accept guard/action names from definition expr bodies as alternative to registry. |
| `src/definition/create-machine.ts` | Compile named exprs, wrap as XState guards/actions via `enqueueActions`, merge with registry, pass to `setup()`. |
| `src/definition/index.ts` | Re-export new types. |
| `package.json` | Add `@durable-machines/expr` workspace dependency. |

### `packages/durable-machine/` (new files)

| File | Responsibility |
|------|----------------|
| `tests/unit/definition/create-machine-expr.test.ts` | Integration tests: machine with expr guards/actions runs transitions correctly. |

---

## Task 0: Fix context chaining in evaluateEnqueue

**Why:** `evaluateEnqueue` evaluates all actions against the same scope. When multiple sequential assigns exist (e.g. `satisfyAU`: flags assign then score assign), each is computed against the ORIGINAL context. If enqueued as separate XState assigns, the last overwrites the first — losing earlier changes. XState's `enqueueActions` processes sequentially with accumulated context. Our evaluator must match.

**Files:**
- Modify: `packages/expr/src/actions.ts:68-79` (evaluateEnqueue)
- Modify: `packages/expr/tests/unit/registration-machine.test.ts` (satisfyAU assertions)
- Modify: `packages/expr/tests/unit/actions.test.ts` (if any multi-assign tests)

- [ ] **Step 1: Write failing test exposing the bug**

In `packages/expr/tests/unit/actions.test.ts`, add:

```typescript
it("sequential assigns chain context (second sees first's changes)", () => {
  const action: EnqueueActionsDef = {
    type: "enqueueActions",
    actions: [
      {
        type: "assign",
        transforms: [{ path: ["a"], set: 1 }],
      },
      {
        type: "assign",
        transforms: [{ path: ["b"], set: 2 }],
      },
    ],
  };

  const scope = createScope({ context: { a: 0, b: 0 } });
  const results = evaluateActions(action, scope, testBuiltins);
  expect(results).toHaveLength(2);

  // Second assign should include first assign's changes
  const ctx1 = (results[1] as { type: "assign"; context: Record<string, unknown> }).context;
  expect(ctx1.a).toBe(1); // from first assign
  expect(ctx1.b).toBe(2); // from second assign
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/expr && npx vitest run --project unit -- actions.test`
Expected: FAIL — `ctx1.a` is `0` (original context), not `1`

- [ ] **Step 3: Fix evaluateEnqueue to chain context**

In `packages/expr/src/actions.ts`, replace `evaluateEnqueue`:

```typescript
function evaluateEnqueue(action: EnqueueActionsDef, scope: Scope, builtins: BuiltinRegistry): ActionResult[] {
  let evalScope = scope;
  if (action.let) {
    evalScope = applyLet(action.let, scope, builtins);
  }

  const results: ActionResult[] = [];
  for (const entry of action.actions) {
    const entryResults = evaluateActions(entry, evalScope, builtins);
    for (const result of entryResults) {
      results.push(result);
      // Chain context: subsequent actions see updated context
      if (result.type === "assign") {
        evalScope = { ...evalScope, context: result.context };
      }
    }
  }
  return results;
}
```

- [ ] **Step 4: Run tests — new test passes, check for regressions**

Run: `cd packages/expr && npx vitest run --project unit`

The `satisfyAU` test (Passed verb with score) may need updating: `results[1].context` (score assign) now also contains the flag changes from `results[0]`. Update assertion to verify accumulated context:

```typescript
// Result 1: guarded assign — score set (accumulated with flags from result 0)
const ctx1 = (results[1] as { type: "assign"; context: Record<string, unknown> }).context;
const au1b = (ctx1.aus as Record<string, unknown>)["au-1"] as Record<string, unknown>;
expect(au1b.score).toEqual({ scaled: 90 });
expect(au1b.hasPassed).toBe(true);  // accumulated from result 0
expect(au1b.method).toBe("passed"); // accumulated from result 0
```

- [ ] **Step 5: Typecheck**

Run: `cd packages/expr && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add packages/expr/src/actions.ts packages/expr/tests/unit/actions.test.ts packages/expr/tests/unit/registration-machine.test.ts
git commit -m "fix(expr): chain context between sequential assigns in evaluateEnqueue"
```

---

## Task 1: Core expression compiler

**Files:**
- Create: `packages/expr/src/compile.ts`
- Create: `packages/expr/tests/unit/compile.test.ts`
- Modify: `packages/expr/src/types.ts:1-10` (add CompiledExpr type)
- Modify: `packages/expr/src/index.ts` (export compile + type)

### Design

`compile(expr, builtins?)` returns `CompiledExpr = (scope: Scope) => unknown`. It walks the expression tree once at compile time, producing a closure tree. At runtime, calling the compiled function only invokes closures — no operator dispatch (`if ("eq" in op)` chain).

Builtins are captured by reference at compile time (the function objects, not their return values). Impure builtins like `uuid()` and `now()` return fresh values on each call.

For `where` predicates in paths, `rewriteWhereStrings` preprocessing happens at compile time. The rewritten predicate is compiled into a closure.

- [ ] **Step 1: Add `CompiledExpr` type**

In `packages/expr/src/types.ts`, add after the `BuiltinRegistry` type (line 122):

```typescript
// ─── Compiled expressions ───────────────────────────────────────────────────

/** A pre-compiled expression — call with a scope to evaluate. */
export type CompiledExpr = (scope: Scope) => unknown;
```

- [ ] **Step 2: Write tests for compile — literals and basic operators**

Create `packages/expr/tests/unit/compile.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { compile } from "../../src/compile.js";
import { evaluate } from "../../src/evaluate.js";
import { createScope } from "../../src/types.js";
import { defaultBuiltins, createBuiltinRegistry } from "../../src/builtins.js";
import type { Scope, Expr } from "../../src/types.js";

const emptyScope = createScope({ context: {} });

/** Helper: verify compiled result matches interpreted result. */
function expectCompiledMatchesEvaluated(expr: Expr, scope: Scope, builtins = defaultBuiltins) {
  const compiled = compile(expr, builtins);
  expect(compiled(scope)).toEqual(evaluate(expr, scope, builtins));
}

describe("compile — literals", () => {
  it("null", () => expect(compile(null)(emptyScope)).toBe(null));
  it("undefined", () => expect(compile(undefined)(emptyScope)).toBe(undefined));
  it("string", () => expect(compile("hello")(emptyScope)).toBe("hello"));
  it("number", () => expect(compile(42)(emptyScope)).toBe(42));
  it("boolean", () => expect(compile(true)(emptyScope)).toBe(true));
  it("array", () => expect(compile([1, 2])(emptyScope)).toEqual([1, 2]));
});

describe("compile — select", () => {
  it("context path", () => {
    const fn = compile({ select: ["context", "name"] });
    expect(fn(createScope({ context: { name: "Alice" } }))).toBe("Alice");
  });

  it("event path", () => {
    const fn = compile({ select: ["event", "type"] });
    expect(fn(createScope({ context: {}, event: { type: "CLICK" } }))).toBe("CLICK");
  });

  it("params path", () => {
    const fn = compile({ select: ["params", "id"] });
    expect(fn(createScope({ context: {}, params: { id: "x" } }))).toBe("x");
  });

  it("bindings (let) path", () => {
    const scope = createScope({ context: {} });
    scope.bindings.temp = "val";
    expect(compile({ select: ["temp", "length"] })(scope)).toBe(undefined);
    // "val" is a string primitive, not navigable — returns undefined
  });

  it("nested path", () => {
    const fn = compile({ select: ["context", "a", "b", "c"] });
    expect(fn(createScope({ context: { a: { b: { c: 42 } } } }))).toBe(42);
  });

  it("missing path returns undefined", () => {
    const fn = compile({ select: ["context", "missing"] });
    expect(fn(createScope({ context: {} }))).toBe(undefined);
  });

  it("param path step", () => {
    const fn = compile({ select: ["context", "items", { param: "key" }] });
    const scope = createScope({ context: { items: { x: 1 } }, params: { key: "x" } });
    expect(fn(scope)).toBe(1);
  });

  it("ref path step", () => {
    const fn = compile({ select: ["context", "items", { ref: "k" }] });
    const scope = createScope({ context: { items: { y: 2 } } });
    scope.bindings.k = "y";
    expect(fn(scope)).toBe(2);
  });

  it("where path step", () => {
    const fn = compile({ select: ["context", "sessions", { where: { eq: ["state", "active"] } }] });
    const scope = createScope({
      context: {
        sessions: {
          s1: { state: "active", auId: "a" },
          s2: { state: "terminated", auId: "b" },
        },
      },
    });
    const result = fn(scope) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["s1"]);
  });

  it("arbitrary expr path step", () => {
    const fn = compile({ select: ["context", "items", { select: ["event", "key"] }] });
    const scope = createScope({ context: { items: { x: 99 } }, event: { key: "x" } });
    expect(fn(scope)).toBe(99);
  });
});

describe("compile — comparisons", () => {
  for (const [op, a, b, expected] of [
    ["eq", 1, 1, true], ["eq", 1, 2, false],
    ["neq", 1, 2, true], ["neq", 1, 1, false],
    ["gt", 3, 2, true], ["gt", 2, 3, false],
    ["lt", 2, 3, true], ["lt", 3, 2, false],
    ["gte", 3, 3, true], ["gte", 2, 3, false],
    ["lte", 3, 3, true], ["lte", 4, 3, false],
  ] as const) {
    it(`${op}([${a}, ${b}]) → ${expected}`, () => {
      expect(compile({ [op]: [a, b] })(emptyScope)).toBe(expected);
    });
  }
});

describe("compile — logic", () => {
  it("and — all true", () => expect(compile({ and: [true, true] })(emptyScope)).toBe(true));
  it("and — one false", () => expect(compile({ and: [true, false] })(emptyScope)).toBe(false));
  it("or — one true", () => expect(compile({ or: [false, true] })(emptyScope)).toBe(true));
  it("or — all false", () => expect(compile({ or: [false, false] })(emptyScope)).toBe(false));
  it("not — true", () => expect(compile({ not: true })(emptyScope)).toBe(false));
  it("if — truthy", () => expect(compile({ if: [true, "yes", "no"] })(emptyScope)).toBe("yes"));
  it("if — falsy", () => expect(compile({ if: [false, "yes", "no"] })(emptyScope)).toBe("no"));
  it("cond — first match", () => {
    const fn = compile({ cond: [[false, "a"], [true, "b"], [true, "c"]] });
    expect(fn(emptyScope)).toBe("b");
  });
  it("cond — no match", () => {
    expect(compile({ cond: [[false, "a"]] })(emptyScope)).toBe(undefined);
  });
});

describe("compile — membership", () => {
  it("in — found", () => expect(compile({ in: [2, [1, 2, 3]] })(emptyScope)).toBe(true));
  it("in — not found", () => expect(compile({ in: [9, [1, 2, 3]] })(emptyScope)).toBe(false));
  it("in — non-array", () => expect(compile({ in: [1, "not-array"] })(emptyScope)).toBe(false));
});

describe("compile — ref and param", () => {
  it("ref", () => {
    const scope = createScope({ context: {} });
    scope.bindings.x = 42;
    expect(compile({ ref: "x" })(scope)).toBe(42);
  });
  it("param", () => {
    const scope = createScope({ context: {}, params: { id: "abc" } });
    expect(compile({ param: "id" })(scope)).toBe("abc");
  });
});

describe("compile — let", () => {
  it("binds and evaluates body", () => {
    const fn = compile({ let: { doubled: { mul: [{ param: "n" }, 2] } }, body: { ref: "doubled" } });
    const scope = createScope({ context: {}, params: { n: 5 } });
    expect(fn(scope)).toBe(10);
  });

  it("sequential bindings reference earlier ones", () => {
    const fn = compile({
      let: { a: 1, b: { add: [{ ref: "a" }, 1] } },
      body: { ref: "b" },
    });
    expect(fn(emptyScope)).toBe(2);
  });
});

describe("compile — nullability", () => {
  it("coalesce — first non-null", () => {
    expect(compile({ coalesce: [null, undefined, "found"] })(emptyScope)).toBe("found");
  });
  it("coalesce — all null", () => {
    expect(compile({ coalesce: [null, undefined] })(emptyScope)).toBe(undefined);
  });
  it("isNull — null", () => expect(compile({ isNull: null })(emptyScope)).toBe(true));
  it("isNull — value", () => expect(compile({ isNull: 42 })(emptyScope)).toBe(false));
});

describe("compile — arithmetic", () => {
  it("add", () => expect(compile({ add: [3, 4] })(emptyScope)).toBe(7));
  it("sub", () => expect(compile({ sub: [10, 3] })(emptyScope)).toBe(7));
  it("mul", () => expect(compile({ mul: [3, 4] })(emptyScope)).toBe(12));
  it("div", () => expect(compile({ div: [10, 2] })(emptyScope)).toBe(5));
});

describe("compile — object", () => {
  it("constructs object with evaluated values", () => {
    const fn = compile({ object: { name: { select: ["context", "name"] }, age: 30 } });
    expect(fn(createScope({ context: { name: "Alice" } }))).toEqual({ name: "Alice", age: 30 });
  });
});

describe("compile — fn (builtins)", () => {
  it("calls builtin with no args", () => {
    const builtins = createBuiltinRegistry({ fixed: () => "ok" });
    expect(compile({ fn: "fixed" }, builtins)(emptyScope)).toBe("ok");
  });

  it("calls builtin with args", () => {
    const builtins = createBuiltinRegistry({ sum: (a: unknown, b: unknown) => (a as number) + (b as number) });
    expect(compile({ fn: "sum", args: [3, 4] }, builtins)(emptyScope)).toBe(7);
  });

  it("missing builtin returns undefined", () => {
    expect(compile({ fn: "missing" })(emptyScope)).toBe(undefined);
  });

  it("impure builtins called fresh each time", () => {
    let counter = 0;
    const builtins = createBuiltinRegistry({ inc: () => ++counter });
    const fn = compile({ fn: "inc" }, builtins);
    expect(fn(emptyScope)).toBe(1);
    expect(fn(emptyScope)).toBe(2);
  });
});

describe("compile — equivalence with evaluate", () => {
  const testCases: [string, Expr, Scope][] = [
    ["nested select + eq", { eq: [{ select: ["context", "x"] }, 5] }, createScope({ context: { x: 5 } })],
    ["let + cond", {
      let: { v: { select: ["event", "type"] } },
      body: { cond: [[{ eq: [{ ref: "v" }, "A"] }, 1], [true, 0]] },
    }, createScope({ context: {}, event: { type: "A" } })],
    ["coalesce + fn", { coalesce: [null, { fn: "uuid" }] }, createScope({ context: {} })],
  ];

  // Note: skip uuid test since it produces different values each call
  for (const [name, expr, scope] of testCases.filter(([n]) => !n.includes("fn"))) {
    it(name, () => expectCompiledMatchesEvaluated(expr, scope));
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/expr && npx vitest run --project unit -- compile.test`
Expected: FAIL — `compile` module doesn't exist

- [ ] **Step 4: Implement `compile`**

Create `packages/expr/src/compile.ts`:

```typescript
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
    const letEntries = Object.entries(op.let as Record<string, Expr>).map(
      ([name, e]) => ({ name, fn: compile(e, builtins) }),
    );
    const body = compile(op.body as Expr, builtins);
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

  // fn — builtin call
  if ("fn" in op && typeof op.fn === "string") {
    const fn = builtins?.[op.fn];
    if (!fn) return () => undefined;
    if ("args" in op && Array.isArray(op.args)) {
      const argFns = (op.args as Expr[]).map(a => compile(a, builtins));
      return (s) => fn(...argFns.map(f => f(s)));
    }
    return () => fn();
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
```

- [ ] **Step 5: Export from index**

In `packages/expr/src/index.ts`, add:

```typescript
export { compile } from "./compile.js";
```

And add `CompiledExpr` to the type exports.

- [ ] **Step 6: Run tests**

Run: `cd packages/expr && npx vitest run --project unit`
Expected: All passing (existing 108 + new compile tests)

- [ ] **Step 7: Typecheck**

Run: `cd packages/expr && npx tsc --noEmit`

- [ ] **Step 8: Commit**

```bash
git add packages/expr/src/compile.ts packages/expr/src/types.ts packages/expr/src/index.ts packages/expr/tests/unit/compile.test.ts
git commit -m "feat(expr): add expression compiler — compile(expr) returns closure tree"
```

---

## Task 2: Guard and action compilers

**Files:**
- Create: `packages/expr/src/compile-actions.ts`
- Create: `packages/expr/tests/unit/compile-actions.test.ts`
- Modify: `packages/expr/src/types.ts` (add `CompiledGuard`, `CompiledAction` types)
- Modify: `packages/expr/src/index.ts` (export new functions and types)

### Design

- `compileGuard(expr, builtins?)` → `CompiledGuard = (scope: Scope) => boolean` — wraps `compile()` with Boolean coercion.
- `compileAction(actionDef, builtins?)` → `CompiledAction = (scope: Scope) => ActionResult[]` — pre-compiles let bindings, guard conditions, and event payloads. Delegates transform application to `applyTransforms` (interpreter) since transforms involve in-place mutation with where fan-outs. The set/append value expressions within transforms are evaluated by `applyTransforms` using the scope (where let bindings are already resolved as compiled closures injected into `scope.bindings`).

- [ ] **Step 1: Add types**

In `packages/expr/src/types.ts`, after the `CompiledExpr` type:

```typescript
/** A pre-compiled guard — returns boolean. */
export type CompiledGuard = (scope: Scope) => boolean;

/** A pre-compiled action — returns action results. */
export type CompiledAction = (scope: Scope) => ActionResult[];
```

- [ ] **Step 2: Write tests**

Create `packages/expr/tests/unit/compile-actions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { compileGuard, compileAction } from "../../src/compile-actions.js";
import { evaluateActions } from "../../src/actions.js";
import { createScope } from "../../src/types.js";
import { createBuiltinRegistry, defaultBuiltins } from "../../src/builtins.js";
import type { ActionDef, EnqueueActionsDef, Scope } from "../../src/types.js";

// ─── compileGuard ────────────────────────────────────────────────────────────

describe("compileGuard", () => {
  it("returns true for truthy expression", () => {
    const guard = compileGuard({ eq: [1, 1] });
    expect(guard(createScope({ context: {} }))).toBe(true);
  });

  it("returns false for falsy expression", () => {
    const guard = compileGuard({ eq: [1, 2] });
    expect(guard(createScope({ context: {} }))).toBe(false);
  });

  it("coerces non-boolean to boolean", () => {
    const guard = compileGuard({ select: ["context", "name"] });
    expect(guard(createScope({ context: { name: "Alice" } }))).toBe(true);
    expect(guard(createScope({ context: { name: "" } }))).toBe(false);
  });

  it("handles let + body (verbSatisfiesAU pattern)", () => {
    const guard = compileGuard({
      let: {
        current: { select: ["context", "aus", { param: "auId" }] },
        nextHasCompleted: { or: [
          { select: ["current", "hasCompleted"] },
          { eq: [{ param: "verbId" }, "http://adlnet.gov/expapi/verbs/completed"] },
        ]},
      },
      body: { and: [
        { eq: [{ select: ["event", "auId"] }, { param: "auId" }] },
        { ref: "nextHasCompleted" },
      ]},
    });

    const scope = createScope({
      context: { aus: { "au-1": { hasCompleted: false } } },
      event: { auId: "au-1" },
      params: { auId: "au-1", verbId: "http://adlnet.gov/expapi/verbs/completed" },
    });
    expect(guard(scope)).toBe(true);
  });
});

// ─── compileAction ───────────────────────────────────────────────────────────

describe("compileAction", () => {
  const testBuiltins = createBuiltinRegistry({
    uuid: () => "test-uuid",
    now: () => 1000,
  });

  it("assign — applies transforms", () => {
    const action: ActionDef = {
      type: "assign",
      transforms: [{ path: ["x"], set: 42 }],
    };
    const compiled = compileAction(action, testBuiltins);
    const results = compiled(createScope({ context: { x: 0 } }));
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("assign");
    expect((results[0] as any).context.x).toBe(42);
  });

  it("emit — evaluates event payload", () => {
    const action: ActionDef = {
      type: "emit",
      event: { type: "DONE", id: { select: ["context", "id"] } },
    };
    const compiled = compileAction(action, testBuiltins);
    const results = compiled(createScope({ context: { id: "abc" } }));
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ type: "emit", event: { type: "DONE", id: "abc" } });
  });

  it("raise — evaluates event payload + delay", () => {
    const action: ActionDef = {
      type: "raise",
      event: { type: "RETRY" },
      delay: 5000,
      id: "retry-1",
    };
    const compiled = compileAction(action, testBuiltins);
    const results = compiled(createScope({ context: {} }));
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ type: "raise", event: { type: "RETRY" }, delay: 5000, id: "retry-1" });
  });

  it("enqueueActions — let bindings + guarded blocks", () => {
    const action: EnqueueActionsDef = {
      type: "enqueueActions",
      let: { ts: { fn: "now" } },
      actions: [
        { type: "assign", transforms: [{ path: ["updatedAt"], set: { ref: "ts" } }] },
        {
          guard: { gt: [{ ref: "ts" }, 0] },
          actions: [{ type: "emit", event: { type: "UPDATED", ts: { ref: "ts" } } }],
        },
      ],
    };
    const compiled = compileAction(action, testBuiltins);
    const results = compiled(createScope({ context: { updatedAt: 0 } }));
    expect(results).toHaveLength(2);
    expect((results[0] as any).context.updatedAt).toBe(1000);
    expect((results[1] as any).event).toEqual({ type: "UPDATED", ts: 1000 });
  });

  it("context chains between sequential assigns", () => {
    const action: EnqueueActionsDef = {
      type: "enqueueActions",
      actions: [
        { type: "assign", transforms: [{ path: ["a"], set: 1 }] },
        { type: "assign", transforms: [{ path: ["b"], set: 2 }] },
      ],
    };
    const compiled = compileAction(action, testBuiltins);
    const results = compiled(createScope({ context: { a: 0, b: 0 } }));
    const ctx1 = (results[1] as any).context;
    expect(ctx1.a).toBe(1);
    expect(ctx1.b).toBe(2);
  });

  it("equivalence with evaluateActions", () => {
    const action: EnqueueActionsDef = {
      type: "enqueueActions",
      let: { x: { add: [{ select: ["context", "n"] }, 1] } },
      actions: [
        { type: "assign", transforms: [{ path: ["n"], set: { ref: "x" } }] },
        { type: "emit", event: { type: "INC", n: { ref: "x" } } },
      ],
    };
    const scope = createScope({ context: { n: 5 } });
    const compiledResults = compileAction(action, testBuiltins)(scope);
    const interpretedResults = evaluateActions(action, scope, testBuiltins);
    expect(compiledResults).toEqual(interpretedResults);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/expr && npx vitest run --project unit -- compile-actions.test`

- [ ] **Step 4: Implement `compileGuard` and `compileAction`**

Create `packages/expr/src/compile-actions.ts`:

```typescript
import type {
  Scope, Expr, ActionDef, ActionResult, GuardedBlock,
  AssignActionDef, EmitActionDef, RaiseActionDef, EnqueueActionsDef,
  BuiltinRegistry, CompiledGuard, CompiledAction,
} from "./types.js";
import { compile } from "./compile.js";
import { applyTransforms } from "./transforms.js";

/**
 * Compile a guard expression into a boolean-returning closure.
 */
export function compileGuard(expr: Expr, builtins?: BuiltinRegistry): CompiledGuard {
  const fn = compile(expr, builtins);
  return (scope: Scope) => Boolean(fn(scope));
}

/**
 * Compile an action definition into a closure returning ActionResult[].
 *
 * Pre-compiles let bindings, guard conditions, and event payloads.
 * Delegates transform application to `applyTransforms` (interpreter).
 */
export function compileAction(actionDef: ActionDef, builtins?: BuiltinRegistry): CompiledAction {
  switch (actionDef.type) {
    case "assign": return compileAssign(actionDef, builtins);
    case "emit": return compileEmit(actionDef, builtins);
    case "raise": return compileRaise(actionDef, builtins);
    case "enqueueActions": return compileEnqueue(actionDef, builtins);
  }
}

function compileAssign(action: AssignActionDef, builtins?: BuiltinRegistry): CompiledAction {
  const compiledLet = action.let ? compileLetBindings(action.let, builtins) : null;
  return (scope) => {
    const evalScope = compiledLet ? applyCompiledLet(compiledLet, scope) : scope;
    const context = applyTransforms(scope.context, action.transforms, evalScope, builtins);
    return [{ type: "assign", context }];
  };
}

function compileEmit(action: EmitActionDef, builtins?: BuiltinRegistry): CompiledAction {
  const compiledEvent = compileEventPayload(action.event, builtins);
  return (scope) => [{ type: "emit", event: compiledEvent(scope) }];
}

function compileRaise(action: RaiseActionDef, builtins?: BuiltinRegistry): CompiledAction {
  const compiledEvent = compileEventPayload(action.event, builtins);
  const compiledDelay = action.delay !== undefined ? compile(action.delay, builtins) : null;
  const id = action.id;
  return (scope) => {
    const result: ActionResult & { type: "raise" } = { type: "raise", event: compiledEvent(scope) };
    if (compiledDelay) result.delay = compiledDelay(scope) as number;
    if (id !== undefined) result.id = id;
    return [result];
  };
}

function compileEnqueue(action: EnqueueActionsDef, builtins?: BuiltinRegistry): CompiledAction {
  const compiledLet = action.let ? compileLetBindings(action.let, builtins) : null;
  const compiledEntries = action.actions.map(entry => compileEntry(entry, builtins));

  return (scope) => {
    let evalScope = compiledLet ? applyCompiledLet(compiledLet, scope) : scope;
    const results: ActionResult[] = [];
    for (const entryFn of compiledEntries) {
      const entryResults = entryFn(evalScope);
      for (const result of entryResults) {
        results.push(result);
        if (result.type === "assign") {
          evalScope = { ...evalScope, context: result.context };
        }
      }
    }
    return results;
  };
}

function compileEntry(entry: ActionDef | GuardedBlock, builtins?: BuiltinRegistry): CompiledAction {
  if ("guard" in entry && "actions" in entry && !("type" in entry)) {
    const guardFn = compile((entry as GuardedBlock).guard, builtins);
    const innerFns = (entry as GuardedBlock).actions.map(a => compileAction(a, builtins));
    return (scope) => {
      if (!guardFn(scope)) return [];
      return innerFns.flatMap(fn => fn(scope));
    };
  }
  return compileAction(entry as ActionDef, builtins);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type CompiledLetBinding = Array<{ name: string; fn: (scope: Scope) => unknown }>;

function compileLetBindings(bindings: Record<string, Expr>, builtins?: BuiltinRegistry): CompiledLetBinding {
  return Object.entries(bindings).map(([name, expr]) => ({ name, fn: compile(expr, builtins) }));
}

function applyCompiledLet(compiledLet: CompiledLetBinding, scope: Scope): Scope {
  const bindings = { ...scope.bindings };
  const inner: Scope = { ...scope, bindings };
  for (const { name, fn } of compiledLet) {
    bindings[name] = fn(inner);
  }
  return inner;
}

function compileEventPayload(
  event: Record<string, Expr>,
  builtins?: BuiltinRegistry,
): (scope: Scope) => Record<string, unknown> {
  const fields = Object.entries(event).map(([key, expr]) => ({ key, fn: compile(expr, builtins) }));
  return (scope) => {
    const result: Record<string, unknown> = {};
    for (const { key, fn } of fields) {
      result[key] = fn(scope);
    }
    return result;
  };
}
```

- [ ] **Step 5: Export from index**

In `packages/expr/src/index.ts`, add:

```typescript
export { compileGuard, compileAction } from "./compile-actions.js";
```

Add `CompiledGuard`, `CompiledAction` to the type exports.

- [ ] **Step 6: Run tests**

Run: `cd packages/expr && npx vitest run --project unit`

- [ ] **Step 7: Typecheck**

Run: `cd packages/expr && npx tsc --noEmit`

- [ ] **Step 8: Commit**

```bash
git add packages/expr/src/compile-actions.ts packages/expr/src/types.ts packages/expr/src/index.ts packages/expr/tests/unit/compile-actions.test.ts
git commit -m "feat(expr): add compileGuard and compileAction — pre-compiled guard/action closures"
```

---

## Task 3: Extend MachineDefinition types and validation

**Files:**
- Modify: `packages/durable-machine/src/definition/types.ts:7-18` (MachineDefinition)
- Modify: `packages/durable-machine/src/definition/validate-definition.ts:23-57,258-284`
- Modify: `packages/durable-machine/package.json` (add workspace dependency)
- Test: `packages/durable-machine/tests/unit/definition/validate-definition.test.ts`

### Design

Add optional `guards` and `actions` sections to `MachineDefinition`. These are named expr bodies that provide guard/action implementations as data — no JS registry entry required.

Validation accepts guard/action names that exist in EITHER the registry OR the definition's expr bodies. Names that exist in both are an error (ambiguous). Names in neither are also an error.

- [ ] **Step 1: Add workspace dependency**

In `packages/durable-machine/package.json`, add to `dependencies`:

```json
"@durable-machines/expr": "workspace:*"
```

Run: `cd /path/to/repo && pnpm install`

- [ ] **Step 2: Extend MachineDefinition**

In `packages/durable-machine/src/definition/types.ts`, add to the `MachineDefinition` interface after `registryId`:

```typescript
  /**
   * Named guard expressions. Each key is a guard name referenced by transitions.
   * At machine creation time, each expr is compiled into a closure.
   */
  guards?: Record<string, unknown>;
  /**
   * Named action expressions. Each key is an action name referenced by transitions.
   * Values are ActionDef objects from @durable-machines/expr.
   * At machine creation time, each expr is compiled into a closure.
   */
  actions?: Record<string, unknown>;
```

(Using `unknown` to avoid requiring the expr package as a type-level dependency of the definition types. The actual `Expr` and `ActionDef` types are enforced at the `createMachineFromDefinition` call site.)

- [ ] **Step 3: Write validation tests**

Add to `packages/durable-machine/tests/unit/definition/validate-definition.test.ts`:

```typescript
describe("expr guard/action definitions", () => {
  it("accepts guard name in definition.guards", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "a",
      guards: { myGuard: { eq: [1, 1] } },
      states: {
        a: { durable: true, on: { GO: { target: "b", guard: "myGuard" } } },
        b: { type: "final" },
      },
    };
    const result = validateDefinition(def, emptyRegistry);
    expect(result.valid).toBe(true);
  });

  it("accepts action name in definition.actions", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "a",
      actions: { myAction: { type: "assign", transforms: [{ path: ["x"], set: 1 }] } },
      states: {
        a: { durable: true, on: { GO: { target: "b", actions: "myAction" } } },
        b: { type: "final" },
      },
    };
    const result = validateDefinition(def, emptyRegistry);
    expect(result.valid).toBe(true);
  });

  it("rejects guard name in both registry and definition (ambiguous)", () => {
    const registry = createImplementationRegistry({
      id: "v1",
      guards: { dup: () => true },
    });
    const def: MachineDefinition = {
      id: "test",
      initial: "a",
      guards: { dup: { eq: [1, 1] } },
      states: {
        a: { durable: true, on: { GO: { target: "b", guard: "dup" } } },
        b: { type: "final" },
      },
    };
    const result = validateDefinition(def, registry);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("ambiguous");
  });

  it("rejects guard name in neither registry nor definition", () => {
    const def: MachineDefinition = {
      id: "test",
      initial: "a",
      states: {
        a: { durable: true, on: { GO: { target: "b", guard: "missing" } } },
        b: { type: "final" },
      },
    };
    const result = validateDefinition(def, emptyRegistry);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("missing");
  });
});
```

(Note: `emptyRegistry` should be a registry with empty guards/actions. If the test file doesn't have one, create it: `const emptyRegistry = createImplementationRegistry({ id: "test" });`)

- [ ] **Step 4: Update validateDefinition**

In `validate-definition.ts`, the `validateTransition` function (line 235) checks guards at line 259:

```typescript
if (trans.guard) {
  const guardType = typeof trans.guard === "string" ? trans.guard : trans.guard.type;
  if (!(guardType in registry.guards)) {
    errors.push(...);
  }
}
```

Replace with:

```typescript
if (trans.guard) {
  const guardType = typeof trans.guard === "string" ? trans.guard : trans.guard.type;
  const inRegistry = guardType in registry.guards;
  const inDefinition = definition.guards != null && guardType in definition.guards;
  if (inRegistry && inDefinition) {
    errors.push(
      `State "${statePath}" ${transDesc} guard "${guardType}" is ambiguous — defined in both registry and definition.guards.`,
    );
  } else if (!inRegistry && !inDefinition) {
    errors.push(
      `State "${statePath}" ${transDesc} references guard "${guardType}" not found in registry or definition.guards.`,
    );
  }
}
```

Same pattern for actions (line 269):

```typescript
for (const action of actionList) {
  const actionType = typeof action === "string" ? action : action.type;
  const inRegistry = actionType in registry.actions;
  const inDefinition = definition.actions != null && actionType in definition.actions;
  if (inRegistry && inDefinition) {
    errors.push(
      `State "${statePath}" ${transDesc} action "${actionType}" is ambiguous — defined in both registry and definition.actions.`,
    );
  } else if (!inRegistry && !inDefinition) {
    errors.push(
      `State "${statePath}" ${transDesc} references action "${actionType}" not found in registry or definition.actions.`,
    );
  }
}
```

This requires threading `definition` through the validation call chain. `validateTransition` currently takes `(statePath, transDesc, trans, siblingStates, rootStates, registry, errors)`. Add `definition: MachineDefinition` parameter. Thread it through `walkStates` → `validateStateNode` → `validateTransitions` → `validateTransition`.

- [ ] **Step 5: Run tests**

Run: `cd packages/durable-machine && npx vitest run --project unit -- validate-definition`
Expected: All passing (existing + new expr definition tests)

- [ ] **Step 6: Typecheck**

Run: `pnpm run typecheck` (from monorepo root)

- [ ] **Step 7: Commit**

```bash
git add packages/durable-machine/package.json packages/durable-machine/src/definition/types.ts packages/durable-machine/src/definition/validate-definition.ts packages/durable-machine/tests/unit/definition/validate-definition.test.ts
git commit -m "feat(durable-machine): extend MachineDefinition with expr guard/action bodies"
```

---

## Task 4: Wire compiled exprs into createMachineFromDefinition

**Files:**
- Modify: `packages/durable-machine/src/definition/create-machine.ts`
- Modify: `packages/durable-machine/src/definition/index.ts` (re-export new types)
- Create: `packages/durable-machine/tests/unit/definition/create-machine-expr.test.ts`

### Design

`createMachineFromDefinition` gains an optional `builtins` parameter (or it's part of an options object). For each named guard/action in `definition.guards`/`.actions`:
1. Compile with `compileGuard`/`compileAction` from `@durable-machines/expr`
2. Wrap guard: `({ context, event }, params) => compiledGuard(createScope({ context, event, params }))`
3. Wrap action: `enqueueActions(({ context, event, enqueue }, params) => { for (result of compiledAction(scope)) { enqueue(xstateAction(result)) } })`
4. Merge with registry (expr-compiled first, registry overwrites — validated no conflicts)
5. Pass merged set to `setup()`

- [ ] **Step 1: Write integration tests**

Create `packages/durable-machine/tests/unit/definition/create-machine-expr.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { initialTransition, transition } from "xstate";
import { createMachineFromDefinition } from "../../../src/definition/create-machine.js";
import { createImplementationRegistry } from "../../../src/definition/registry.js";
import type { MachineDefinition } from "../../../src/definition/types.js";
import { createBuiltinRegistry } from "@durable-machines/expr";

describe("createMachineFromDefinition with expr guards/actions", () => {
  const builtins = createBuiltinRegistry({
    uuid: () => "test-uuid",
    now: () => 1000,
  });

  const emptyRegistry = createImplementationRegistry({ id: "test" });

  it("expr guard controls transition", () => {
    const def: MachineDefinition = {
      id: "counter",
      initial: "low",
      context: { count: 0 },
      guards: {
        isHigh: { gt: [{ select: ["context", "count"] }, 5] },
      },
      actions: {
        increment: { type: "assign", transforms: [{ path: ["count"], set: { add: [{ select: ["context", "count"] }, 1] } }] },
      },
      states: {
        low: {
          durable: true,
          on: {
            INC: [
              { target: "high", guard: "isHigh", actions: "increment" },
              { actions: "increment" },
            ],
          },
        },
        high: { type: "final" },
      },
    };

    const machine = createMachineFromDefinition(def, emptyRegistry, { builtins });

    // Initial state
    let [state] = initialTransition(machine);
    expect(state.value).toBe("low");
    expect(state.context.count).toBe(0);

    // Send INC events — should stay in low until count > 5
    for (let i = 0; i < 6; i++) {
      [state] = transition(machine, state, { type: "INC" });
      expect(state.value).toBe("low");
    }
    // count is now 6 — next INC triggers isHigh guard
    [state] = transition(machine, state, { type: "INC" });
    expect(state.value).toBe("high");
    expect(state.context.count).toBe(7);
  });

  it("expr action with params", () => {
    const def: MachineDefinition = {
      id: "paramtest",
      initial: "idle",
      context: { items: { a: 0, b: 0 } },
      actions: {
        setItem: {
          type: "assign",
          transforms: [{ path: ["items", { param: "key" }], set: { param: "value" } }],
        },
      },
      states: {
        idle: {
          durable: true,
          on: {
            SET: { actions: { type: "setItem", params: { key: "a", value: 42 } } },
          },
        },
      },
    };

    const machine = createMachineFromDefinition(def, emptyRegistry, { builtins });
    let [state] = initialTransition(machine);
    [state] = transition(machine, state, { type: "SET" });
    expect(state.context.items.a).toBe(42);
    expect(state.context.items.b).toBe(0);
  });

  it("enqueueActions with emit", () => {
    const def: MachineDefinition = {
      id: "emitter",
      initial: "idle",
      context: { n: 0 },
      actions: {
        incAndEmit: {
          type: "enqueueActions",
          actions: [
            { type: "assign", transforms: [{ path: ["n"], set: { add: [{ select: ["context", "n"] }, 1] } }] },
            { type: "emit", event: { type: "INCREMENTED", n: { add: [{ select: ["context", "n"] }, 1] } } },
          ],
        },
      },
      states: {
        idle: {
          durable: true,
          on: { INC: { actions: "incAndEmit" } },
        },
      },
    };

    const machine = createMachineFromDefinition(def, emptyRegistry, { builtins });
    let [state] = initialTransition(machine);
    [state] = transition(machine, state, { type: "INC" });
    // Context should be updated
    expect(state.context.n).toBe(1);
  });

  it("mixed: expr actions + registry actors", () => {
    // Verifies that expr actions coexist with JS registry entries
    const registry = createImplementationRegistry({
      id: "v1",
      actors: {},
      guards: {},
      actions: {},
      delays: { shortDelay: 100 },
    });

    const def: MachineDefinition = {
      id: "mixed",
      initial: "idle",
      context: { x: 0 },
      actions: {
        bump: { type: "assign", transforms: [{ path: ["x"], set: { add: [{ select: ["context", "x"] }, 1] } }] },
      },
      states: {
        idle: {
          durable: true,
          on: { GO: { target: "done", actions: "bump" } },
        },
        done: { type: "final" },
      },
    };

    const machine = createMachineFromDefinition(def, registry, { builtins });
    let [state] = initialTransition(machine);
    [state] = transition(machine, state, { type: "GO" });
    expect(state.value).toBe("done");
    expect(state.context.x).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/durable-machine && npx vitest run --project unit -- create-machine-expr`

- [ ] **Step 3: Update `createMachineFromDefinition`**

In `packages/durable-machine/src/definition/create-machine.ts`:

```typescript
import type { AnyStateMachine } from "xstate";
import { setup, assign, enqueueActions } from "xstate";
import { emit, raise } from "xstate";
import type { MachineDefinition } from "./types.js";
import type { ImplementationRegistry } from "./registry.js";
import { validateDefinition } from "./validate-definition.js";
import { transformDefinition } from "./transform.js";
import { DurableMachineValidationError } from "../types.js";
import {
  compileGuard, compileAction, createScope,
  type BuiltinRegistry, type ActionResult,
} from "@durable-machines/expr";

export interface ExprOptions {
  builtins?: BuiltinRegistry;
}

export function createMachineFromDefinition(
  definition: MachineDefinition,
  registry: ImplementationRegistry,
  exprOptions?: ExprOptions,
): AnyStateMachine {
  // 1. Validate
  const result = validateDefinition(definition, registry);
  if (!result.valid) {
    throw new DurableMachineValidationError(result.errors);
  }

  // 2. Transform JSON → XState config
  const config = transformDefinition(definition, registry);

  // 3. Compile expr guard/action definitions
  const builtins = exprOptions?.builtins;

  const compiledGuards: Record<string, (...args: any[]) => boolean> = {};
  if (definition.guards) {
    for (const [name, guardExpr] of Object.entries(definition.guards)) {
      const compiled = compileGuard(guardExpr, builtins);
      compiledGuards[name] = ({ context, event }: any, params: any) =>
        compiled(createScope({ context, event, params: params?.params ?? params ?? {} }));
    }
  }

  const compiledActions: Record<string, (...args: any[]) => void> = {};
  if (definition.actions) {
    for (const [name, actionDef] of Object.entries(definition.actions)) {
      const compiled = compileAction(actionDef as any, builtins);
      compiledActions[name] = enqueueActions(({ context, event, enqueue }: any, params: any) => {
        const scope = createScope({ context, event, params: params?.params ?? params ?? {} });
        const results = compiled(scope);
        for (const r of results) {
          switch (r.type) {
            case "assign":
              enqueue(assign(() => r.context));
              break;
            case "emit":
              enqueue(emit(r.event as any));
              break;
            case "raise":
              enqueue(raise(r.event as any));
              break;
          }
        }
      }) as any;
    }
  }

  // 4. Merge: expr-compiled + registry (registry wins on conflict, but validated no conflicts)
  const mergedGuards = { ...compiledGuards, ...registry.guards };
  const mergedActions = { ...compiledActions, ...registry.actions };

  // 5. Create machine via setup()
  const machine = setup({
    actors: registry.actors as any,
    guards: mergedGuards as any,
    actions: mergedActions as any,
    delays: registry.delays as any,
  }).createMachine(config as any);

  return machine;
}
```

**Note on `params` threading:** XState v5 passes params from the transition definition as the second argument to guard/action functions. The shape depends on how the guard/action is referenced:
- String reference (`guard: "myGuard"`): params is `undefined`
- Object reference (`guard: { type: "myGuard", params: { ... } }`): params is `{ params: { ... } }`

The wrapper normalizes this via `params?.params ?? params ?? {}`. Verify the exact shape in the integration tests and adjust if needed.

- [ ] **Step 4: Update exports**

In `packages/durable-machine/src/definition/index.ts`, add:

```typescript
export type { ExprOptions } from "./create-machine.js";
```

- [ ] **Step 5: Run tests**

Run: `cd packages/durable-machine && npx vitest run --project unit -- create-machine`
Expected: All passing (existing + new expr tests)

- [ ] **Step 6: Run full test suite + typecheck**

Run: `cd packages/durable-machine && npx vitest run --project unit`
Run: `pnpm run typecheck` (from monorepo root)

- [ ] **Step 7: Commit**

```bash
git add packages/durable-machine/src/definition/create-machine.ts packages/durable-machine/src/definition/index.ts packages/durable-machine/tests/unit/definition/create-machine-expr.test.ts
git commit -m "feat(durable-machine): compile expr guards/actions into XState machine at registration time"
```

---

## Task 5: Paper prototype validation — registration machine via createMachineFromDefinition

End-to-end smoke test: take the paper prototype's `verbSatisfiesAU` guard and `satisfyAU` action, define them in a `MachineDefinition`, create a machine, and run a transition.

**Files:**
- Create: `packages/durable-machine/tests/unit/definition/registration-machine-expr.test.ts`

- [ ] **Step 1: Write end-to-end test**

```typescript
import { describe, it, expect } from "vitest";
import { initialTransition, transition } from "xstate";
import { createMachineFromDefinition } from "../../../src/definition/create-machine.js";
import { createImplementationRegistry } from "../../../src/definition/registry.js";
import type { MachineDefinition } from "../../../src/definition/types.js";
import { createBuiltinRegistry } from "@durable-machines/expr";

describe("registration machine via expr definitions", () => {
  const testBuiltins = createBuiltinRegistry({
    uuid: () => "test-uuid",
    now: () => 1718452800000,
  });

  const emptyRegistry = createImplementationRegistry({ id: "test" });

  it("verbSatisfiesAU guard + satisfyAU action — full transition", () => {
    const def: MachineDefinition = {
      id: "au-lifecycle",
      initial: "unsatisfied",
      context: {
        aus: {
          "au-1": { hasCompleted: false, hasPassed: false, hasFailed: false, method: null, satisfiedAt: null, score: null },
        },
        lastSatisfyingSessionId: null,
      },
      guards: {
        verbSatisfiesAU: {
          let: {
            current: { select: ["context", "aus", { param: "auId" }] },
            score: { select: ["event", "score"] },
            nextHasCompleted: { or: [
              { select: ["current", "hasCompleted"] },
              { eq: [{ param: "verbId" }, "http://adlnet.gov/expapi/verbs/completed"] },
            ]},
            nextHasPassed: { or: [
              { select: ["current", "hasPassed"] },
              { and: [
                { eq: [{ param: "verbId" }, "http://adlnet.gov/expapi/verbs/passed"] },
                { if: [{ isNull: { ref: "score" } }, true, { gte: [{ ref: "score" }, { param: "masteryScore" }] }] },
              ]},
            ]},
          },
          body: { and: [
            { eq: [{ select: ["event", "auId"] }, { param: "auId" }] },
            { cond: [
              [{ eq: [{ param: "moveOn" }, "Completed"] }, { ref: "nextHasCompleted" }],
              [{ eq: [{ param: "moveOn" }, "Passed"] }, { ref: "nextHasPassed" }],
              [true, false],
            ]},
          ]},
        },
      },
      actions: {
        satisfyAU: {
          type: "enqueueActions",
          let: {
            sessionId: { coalesce: [{ select: ["event", "sessionId"] }, { fn: "uuid" }] },
            timestamp: { coalesce: [{ select: ["event", "timestamp"] }, { fn: "now" }] },
          },
          actions: [
            {
              type: "assign",
              transforms: [
                { path: ["aus", { param: "auId" }, "hasPassed"], set: true },
                { path: ["aus", { param: "auId" }, "method"], set: "passed" },
                { path: ["aus", { param: "auId" }, "satisfiedAt"], set: { ref: "timestamp" } },
                { path: ["lastSatisfyingSessionId"], set: { ref: "sessionId" } },
              ],
            },
          ],
        },
      },
      states: {
        unsatisfied: {
          durable: true,
          on: {
            VERB_RECEIVED: {
              target: "satisfied",
              guard: {
                type: "verbSatisfiesAU",
                params: { auId: "au-1", moveOn: "Passed", masteryScore: 80, verbId: "http://adlnet.gov/expapi/verbs/passed" },
              },
              actions: {
                type: "satisfyAU",
                params: { auId: "au-1", moveOn: "Passed", masteryScore: 80, verbId: "http://adlnet.gov/expapi/verbs/passed" },
              },
            },
          },
        },
        satisfied: { type: "final" },
      },
    };

    const machine = createMachineFromDefinition(def, emptyRegistry, { builtins: testBuiltins });

    // Initial state
    let [state] = initialTransition(machine);
    expect(state.value).toBe("unsatisfied");

    // Send passing verb with score >= masteryScore → should transition
    [state] = transition(machine, state, {
      type: "VERB_RECEIVED",
      auId: "au-1",
      verbId: "http://adlnet.gov/expapi/verbs/passed",
      score: 90,
      sessionId: "session-abc",
      timestamp: 1718452800000,
    });

    expect(state.value).toBe("satisfied");
    const au1 = (state.context.aus as any)["au-1"];
    expect(au1.hasPassed).toBe(true);
    expect(au1.method).toBe("passed");
    expect(au1.satisfiedAt).toBe(1718452800000);
    expect(state.context.lastSatisfyingSessionId).toBe("session-abc");
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd packages/durable-machine && npx vitest run --project unit -- registration-machine-expr`
Expected: PASS

- [ ] **Step 3: Run full test suite + typecheck**

Run: `cd packages/durable-machine && npx vitest run --project unit`
Run: `pnpm run typecheck`

- [ ] **Step 4: Commit**

```bash
git add packages/durable-machine/tests/unit/definition/registration-machine-expr.test.ts
git commit -m "test(durable-machine): paper prototype guard+action via expr definitions end-to-end"
```

---

## Verification

1. **Expr unit tests:** `cd packages/expr && npx vitest run --project unit` — all passing (108 existing + ~50 new compile tests)
2. **Durable-machine unit tests:** `cd packages/durable-machine && npx vitest run --project unit` — all passing (existing + new expr definition tests)
3. **Typecheck:** `pnpm run typecheck` from monorepo root — clean
4. **Lint:** `pnpm lint:arch` — all FTA scores under caps
