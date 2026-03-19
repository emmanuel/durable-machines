# `$.` Dot-Path Sugar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `$.path` string sugar that desugars to `select` expressions in `@durable-machines/expr`, with full interpreter and compiler support.

**Architecture:** A pure `parseDollarPath` function handles string→select desugaring. Both `evaluate()` and `compile()` intercept `$.`-prefixed strings at entry, before the operator dispatch chain. `ref` stays unchanged as a bindings-only operator. `where.ts` `wrapIfString` updated for consistency.

**Tech Stack:** TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-03-18-dollar-path-sugar-design.md`

---

### Task 1: Create `parseDollarPath` with tests

**Files:**
- Create: `packages/expr/src/desugar.ts`
- Create: `packages/expr/tests/unit/desugar.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/expr/tests/unit/desugar.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDollarPath } from "../../src/desugar.js";

describe("parseDollarPath", () => {
  it("parses single-segment path", () => {
    expect(parseDollarPath("$.context")).toEqual({ select: ["context"] });
  });

  it("parses two-segment path", () => {
    expect(parseDollarPath("$.context.count")).toEqual({ select: ["context", "count"] });
  });

  it("parses deeply nested path", () => {
    expect(parseDollarPath("$.a.b.c.d")).toEqual({ select: ["a", "b", "c", "d"] });
  });

  it("parses binding name", () => {
    expect(parseDollarPath("$.myBinding")).toEqual({ select: ["myBinding"] });
  });

  it("throws on empty path (just $.)", () => {
    expect(() => parseDollarPath("$.")).toThrow();
  });

  it("throws on empty segment (double dot)", () => {
    expect(() => parseDollarPath("$.context..foo")).toThrow();
  });

  it("throws on trailing dot", () => {
    expect(() => parseDollarPath("$.context.")).toThrow();
  });

  it("parses path with hyphens and numbers", () => {
    expect(parseDollarPath("$.context.au-1.score")).toEqual({ select: ["context", "au-1", "score"] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/expr && npx vitest run tests/unit/desugar.test.ts`
Expected: FAIL — module `../../src/desugar.js` not found

- [ ] **Step 3: Write minimal implementation**

Create `packages/expr/src/desugar.ts`:

```ts
/**
 * Parse a `$.path.to.value` sugar string into a `select` expression.
 *
 * @param s — a string starting with `$.` (e.g. `"$.context.count"`)
 * @returns an object `{ select: string[] }` ready for evaluation
 * @throws if the path is empty or contains empty segments
 */
export function parseDollarPath(s: string): { select: string[] } {
  const path = s.slice(2); // strip "$."
  if (path === "" || path.startsWith(".") || path.endsWith(".") || path.includes("..")) {
    throw new Error(`Invalid dollar path: "${s}"`);
  }
  return { select: path.split(".") };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/desugar.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expr/src/desugar.ts packages/expr/tests/unit/desugar.test.ts
git commit -m "feat(expr): add parseDollarPath for \$.path sugar"
```

---

### Task 2: Integrate `$.` sugar into `evaluate()`

**Files:**
- Modify: `packages/expr/src/evaluate.ts` (line 103)
- Modify: `packages/expr/tests/unit/evaluate.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/expr/tests/unit/evaluate.test.ts`:

```ts
describe("evaluate — $.path sugar", () => {
  it("$.context.count resolves like select", () => {
    const scope = createScope({ context: { count: 42 } });
    expect(evaluate("$.context.count", scope)).toBe(42);
    expect(evaluate("$.context.count", scope)).toBe(
      evaluate({ select: ["context", "count"] }, scope),
    );
  });

  it("$.event.output resolves like select", () => {
    const scope = createScope({ context: {}, event: { output: "ok" } });
    expect(evaluate("$.event.output", scope)).toBe("ok");
  });

  it("$.context returns the full context object", () => {
    const ctx = { a: 1, b: 2 };
    const scope = createScope({ context: ctx });
    expect(evaluate("$.context", scope)).toBe(ctx);
  });

  it("$.binding resolves from bindings via selectPath", () => {
    const scope = createScope({ context: {} });
    scope.bindings.myVar = "hello";
    expect(evaluate("$.myVar", scope)).toBe("hello");
  });

  it("nested in object expr", () => {
    const scope = createScope({ context: {}, event: { y: 99 } });
    expect(evaluate({ object: { x: "$.event.y" } }, scope)).toEqual({ x: 99 });
  });

  it("in let body", () => {
    const scope = createScope({ context: { count: 10 } });
    expect(evaluate({ let: [{ total: "$.context.count" }, "$.total"] }, scope)).toBe(10);
  });

  it("plain strings are unchanged", () => {
    const scope = createScope({ context: {} });
    expect(evaluate("hello", scope)).toBe("hello");
  });

  it("$ without dot is literal", () => {
    const scope = createScope({ context: {} });
    expect(evaluate("$notDotPath", scope)).toBe("$notDotPath");
  });

  it("bare $ is literal", () => {
    const scope = createScope({ context: {} });
    expect(evaluate("$", scope)).toBe("$");
  });

  it("$.  with invalid path throws", () => {
    const scope = createScope({ context: {} });
    expect(() => evaluate("$.", scope)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/expr && npx vitest run tests/unit/evaluate.test.ts`
Expected: `"$.context.count"` returns the literal string `"$.context.count"` instead of `42`

- [ ] **Step 3: Modify evaluate.ts**

In `packages/expr/src/evaluate.ts`:

1. Add import at the top:
```ts
import { parseDollarPath } from "./desugar.js";
```

2. Replace line 103:
```ts
if (typeof expr === "string" || typeof expr === "number" || typeof expr === "boolean") return expr;
```
With:
```ts
if (typeof expr === "string") {
  if (expr.startsWith("$.")) return evaluate(parseDollarPath(expr), scope, builtins);
  return expr;
}
if (typeof expr === "number" || typeof expr === "boolean") return expr;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/evaluate.test.ts`
Expected: All tests PASS (both new and existing)

- [ ] **Step 5: Commit**

```bash
git add packages/expr/src/evaluate.ts packages/expr/tests/unit/evaluate.test.ts
git commit -m "feat(expr): integrate \$.path sugar into evaluate()"
```

---

### Task 3: Integrate `$.` sugar into `compile()`

**Files:**
- Modify: `packages/expr/src/compile.ts` (line 17)
- Modify: `packages/expr/tests/unit/compile.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/expr/tests/unit/compile.test.ts`:

```ts
describe("compile — $.path sugar", () => {
  it("$.context.count resolves like select", () => {
    const scope = createScope({ context: { count: 42 } });
    const fn = compile("$.context.count");
    expect(fn(scope)).toBe(42);
    expectCompiledMatchesEvaluated("$.context.count", scope);
  });

  it("$.event.output resolves like select", () => {
    const scope = createScope({ context: {}, event: { output: "ok" } });
    expect(compile("$.event.output")(scope)).toBe("ok");
    expectCompiledMatchesEvaluated("$.event.output", scope);
  });

  it("$.context returns full context object", () => {
    const ctx = { a: 1, b: 2 };
    const scope = createScope({ context: ctx });
    expect(compile("$.context")(scope)).toBe(ctx);
  });

  it("$.binding resolves from bindings", () => {
    const scope = createScope({ context: {} });
    scope.bindings.myVar = "hello";
    expect(compile("$.myVar")(scope)).toBe("hello");
    expectCompiledMatchesEvaluated("$.myVar", scope);
  });

  it("nested in object expr", () => {
    const scope = createScope({ context: {}, event: { y: 99 } });
    const fn = compile({ object: { x: "$.event.y" } });
    expect(fn(scope)).toEqual({ x: 99 });
    expectCompiledMatchesEvaluated({ object: { x: "$.event.y" } }, scope);
  });

  it("in let body", () => {
    const scope = createScope({ context: { count: 10 } });
    const fn = compile({ let: [{ total: "$.context.count" }, "$.total"] });
    expect(fn(scope)).toBe(10);
    expectCompiledMatchesEvaluated({ let: [{ total: "$.context.count" }, "$.total"] }, scope);
  });

  it("plain strings are unchanged", () => {
    expect(compile("hello")(emptyScope)).toBe("hello");
  });

  it("$ without dot is literal", () => {
    expect(compile("$notDotPath")(emptyScope)).toBe("$notDotPath");
  });

  it("bare $ is literal", () => {
    expect(compile("$")(emptyScope)).toBe("$");
  });

  it("$. with invalid path throws", () => {
    expect(() => compile("$.")).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/expr && npx vitest run tests/unit/compile.test.ts`
Expected: `"$.context.count"` compiles to a literal string closure instead of a select path

- [ ] **Step 3: Modify compile.ts**

In `packages/expr/src/compile.ts`:

1. Add import at the top:
```ts
import { parseDollarPath } from "./desugar.js";
```

2. Replace line 17:
```ts
if (typeof expr === "string" || typeof expr === "number" || typeof expr === "boolean") return () => expr;
```
With:
```ts
if (typeof expr === "string") {
  if (expr.startsWith("$.")) return compile(parseDollarPath(expr), builtins);
  return () => expr;
}
if (typeof expr === "number" || typeof expr === "boolean") return () => expr;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/compile.test.ts`
Expected: All tests PASS (both new and existing)

- [ ] **Step 5: Commit**

```bash
git add packages/expr/src/compile.ts packages/expr/tests/unit/compile.test.ts
git commit -m "feat(expr): integrate \$.path sugar into compile()"
```

---

### Task 4: Update `where.ts` `wrapIfString`

**Files:**
- Modify: `packages/expr/src/where.ts` (lines 52-57)
- Modify: `packages/expr/tests/unit/path.test.ts` (where tests live here)

- [ ] **Step 1: Write the failing test**

Find the existing `where` test section in `packages/expr/tests/unit/path.test.ts`. Add the `evaluate` import at the top of the file:

```ts
import { evaluate } from "../../src/evaluate.js";
```

Then add to the `where` test section:

```ts
it("$.path sugar works inside where predicates", () => {
  const scope = createScope({
    context: {
      items: {
        a: { state: "active", value: 1 },
        b: { state: "done", value: 2 },
        c: { state: "active", value: 3 },
      },
    },
    event: { targetState: "active" },
  });
  // Use $.event.targetState as the comparison value inside a where predicate
  const result = evaluate(
    { select: ["context", "items", { where: { eq: ["state", "$.event.targetState"] } }] },
    scope,
  );
  expect(result).toEqual({
    a: { state: "active", value: 1 },
    c: { state: "active", value: 3 },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/expr && npx vitest run tests/unit/path.test.ts`
Expected: FAIL — `"$.event.targetState"` is treated as a literal string, not a select expression. The comparison `"active" === "$.event.targetState"` fails.

- [ ] **Step 3: Modify where.ts**

In `packages/expr/src/where.ts`:

1. Add import at the top:
```ts
import { parseDollarPath } from "./desugar.js";
```

2. Replace `wrapIfString` (lines 52-57):
```ts
function wrapIfString(expr: Expr): Expr {
  if (typeof expr === "string") {
    return { ref: expr };
  }
  return expr;
}
```
With:
```ts
function wrapIfString(expr: Expr): Expr {
  if (typeof expr === "string") {
    if (expr.startsWith("$.")) return parseDollarPath(expr);
    return { ref: expr };
  }
  return expr;
}
```

Note: bare field name strings keep using `{ ref: expr }` (bindings-only) to avoid scope-widening when entry fields collide with scope root names like `"context"`, `"event"`, or `"params"`. Only `$.`-prefixed strings get the full `select` treatment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/path.test.ts`
Expected: All tests PASS (both new and existing where tests)

- [ ] **Step 5: Add compile-path where test**

Append to `packages/expr/tests/unit/compile.test.ts`:

```ts
describe("compile — $.path sugar inside where predicates", () => {
  it("$.path sugar works inside compiled where predicates", () => {
    const fn = compile({
      select: ["context", "items", { where: { eq: ["state", "$.event.targetState"] } }],
    });
    const scope = createScope({
      context: {
        items: {
          a: { state: "active", value: 1 },
          b: { state: "done", value: 2 },
        },
      },
      event: { targetState: "active" },
    });
    expect(fn(scope)).toEqual({ a: { state: "active", value: 1 } });
  });
});
```

- [ ] **Step 6: Run full test suite**

Run: `cd packages/expr && npx vitest run`
Expected: All tests across all test files PASS. Bare field name strings in `where` still use `{ ref: expr }` (bindings-only), so no semantic change for existing `where` predicates.

- [ ] **Step 7: Commit**

```bash
git add packages/expr/src/where.ts packages/expr/tests/unit/path.test.ts packages/expr/tests/unit/compile.test.ts
git commit -m "feat(expr): add \$.path sugar support in where predicates"
```

---

### Task 5: Add pipe/special-binding sugar tests

**Files:**
- Modify: `packages/expr/tests/unit/evaluate.test.ts`
- Modify: `packages/expr/tests/unit/compile.test.ts`

- [ ] **Step 1: Add pipe/special-binding tests to evaluate.test.ts**

Append to `packages/expr/tests/unit/evaluate.test.ts`:

```ts
describe("evaluate — $.path sugar with pipe and special bindings", () => {
  it("$.$ inside pipe resolves pipe accumulator", () => {
    const scope = createScope({ context: { nums: [1, 2, 3] } });
    const expr = {
      pipe: [
        { select: ["context", "nums"] },
        { len: "$.$" },
      ],
    };
    expect(evaluate(expr, scope)).toBe(3);
  });

  it("$.$index inside map resolves iteration index", () => {
    const scope = createScope({ context: { items: ["a", "b", "c"] } });
    const expr = {
      map: [{ select: ["context", "items"] }, "item", "$.$index"],
    };
    expect(evaluate(expr, scope)).toEqual([0, 1, 2]);
  });

  it("$.$key inside mapVals resolves current key", () => {
    const scope = createScope({ context: { obj: { x: 1, y: 2 } } });
    const expr = {
      mapVals: [{ select: ["context", "obj"] }, "val", "$.$key"],
    };
    expect(evaluate(expr, scope)).toEqual({ x: "x", y: "y" });
  });
});
```

- [ ] **Step 2: Add pipe/special-binding tests to compile.test.ts**

Append to `packages/expr/tests/unit/compile.test.ts`:

```ts
describe("compile — $.path sugar with pipe and special bindings", () => {
  it("$.$ inside pipe resolves pipe accumulator", () => {
    const scope = createScope({ context: { nums: [1, 2, 3] } });
    const expr = {
      pipe: [
        { select: ["context", "nums"] },
        { len: "$.$" },
      ],
    };
    expect(compile(expr)(scope)).toBe(3);
    expectCompiledMatchesEvaluated(expr, scope);
  });

  it("$.$index inside map resolves iteration index", () => {
    const scope = createScope({ context: { items: ["a", "b", "c"] } });
    const expr = {
      map: [{ select: ["context", "items"] }, "item", "$.$index"],
    };
    expect(compile(expr)(scope)).toEqual([0, 1, 2]);
    expectCompiledMatchesEvaluated(expr, scope);
  });

  it("$.$key inside mapVals resolves current key", () => {
    const scope = createScope({ context: { obj: { x: 1, y: 2 } } });
    const expr = {
      mapVals: [{ select: ["context", "obj"] }, "val", "$.$key"],
    };
    expect(compile(expr)(scope)).toEqual({ x: "x", y: "y" });
    expectCompiledMatchesEvaluated(expr, scope);
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/evaluate.test.ts tests/unit/compile.test.ts`
Expected: All tests PASS — these tests exercise the already-integrated `$.` sugar with pipe/collection operators.

- [ ] **Step 4: Commit**

```bash
git add packages/expr/tests/unit/evaluate.test.ts packages/expr/tests/unit/compile.test.ts
git commit -m "test(expr): add \$.path sugar tests for pipe, \$index, \$key bindings"
```

---

### Task 6: Add ref backward-compatibility tests

**Files:**
- Modify: `packages/expr/tests/unit/evaluate.test.ts`
- Modify: `packages/expr/tests/unit/compile.test.ts`

- [ ] **Step 1: Add ref backward-compat tests to evaluate.test.ts**

Append to `packages/expr/tests/unit/evaluate.test.ts`:

```ts
describe("evaluate — ref stays bindings-only (backward compat)", () => {
  it("ref resolves from bindings", () => {
    const scope = createScope({ context: {} });
    scope.bindings.x = "hello";
    expect(evaluate({ ref: "x" }, scope)).toBe("hello");
  });

  it("let-bound name shadowing scope root: ref returns binding", () => {
    const scope = createScope({ context: {}, event: { type: "CLICK" } });
    const expr = { let: [{ event: "someValue" }, { ref: "event" }] };
    expect(evaluate(expr, scope)).toBe("someValue");
  });

  it("$.event resolves scope root (different from ref)", () => {
    const scope = createScope({ context: {}, event: { type: "CLICK" } });
    const expr = { let: [{ event: "someValue" }, "$.event"] };
    // $.event → { select: ["event"] } → scope.event (the root, not the binding)
    expect(evaluate(expr, scope)).toEqual({ type: "CLICK" });
  });
});
```

- [ ] **Step 2: Add ref backward-compat tests to compile.test.ts**

Append to `packages/expr/tests/unit/compile.test.ts`:

```ts
describe("compile — ref stays bindings-only (backward compat)", () => {
  it("ref resolves from bindings", () => {
    const scope = createScope({ context: {} });
    scope.bindings.x = "hello";
    expect(compile({ ref: "x" })(scope)).toBe("hello");
    expectCompiledMatchesEvaluated({ ref: "x" }, scope);
  });

  it("let-bound name shadowing scope root: ref returns binding", () => {
    const scope = createScope({ context: {}, event: { type: "CLICK" } });
    const expr = { let: [{ event: "someValue" }, { ref: "event" }] };
    expect(compile(expr)(scope)).toBe("someValue");
    expectCompiledMatchesEvaluated(expr, scope);
  });

  it("$.event resolves scope root (different from ref)", () => {
    const scope = createScope({ context: {}, event: { type: "CLICK" } });
    const expr = { let: [{ event: "someValue" }, "$.event"] };
    expect(compile(expr)(scope)).toEqual({ type: "CLICK" });
    expectCompiledMatchesEvaluated(expr, scope);
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/evaluate.test.ts tests/unit/compile.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/expr/tests/unit/evaluate.test.ts packages/expr/tests/unit/compile.test.ts
git commit -m "test(expr): verify ref stays bindings-only, distinct from \$.path sugar"
```

---

### Task 7: Export `parseDollarPath` and update EXPR_SPEC

**Files:**
- Modify: `packages/expr/src/index.ts`
- Modify: `packages/expr/EXPR_SPEC.md`

- [ ] **Step 1: Add export to index.ts**

In `packages/expr/src/index.ts`, add after the `compile` export:

```ts
export { parseDollarPath } from "./desugar.js";
```

- [ ] **Step 2: Update EXPR_SPEC.md**

Add a new section after **3.1 Literals** (before **3.2 Operator Objects**):

```markdown
### 3.2 Dollar-Path Sugar

If the input is a **string** starting with `$.`, it is desugared to a `select` expression before evaluation:

| Input string | Equivalent expression |
|---|---|
| `"$.context.count"` | `{ "select": ["context", "count"] }` |
| `"$.event.data.id"` | `{ "select": ["event", "data", "id"] }` |
| `"$.myBinding"` | `{ "select": ["myBinding"] }` |

**Rules:**
- The `$.` prefix is stripped and the remainder is split on `.` to form the `select` path array.
- Each segment must be non-empty. `"$."`, `"$.a..b"`, and `"$.a."` are errors.
- Strings starting with `$` but without a following `.` (e.g., `"$notDot"`, `"$"`) remain string literals.
- `"$.x"` resolves via `select` (scope-wide: context → event → params → bindings). This differs from `{ "ref": "x" }`, which resolves from `bindings` only.

**Interaction with special bindings:**
- `"$.$"` resolves the `pipe` accumulator (`bindings.$`)
- `"$.$index"` resolves the iteration index (`bindings.$index`)
- `"$.$key"` resolves the current key in `mapVals`/`filterKeys` (`bindings.$key`)
```

Renumber subsequent sections: old 3.2 → 3.3, old 3.3 → 3.4, old 3.4 → 3.5, old 3.5 → 3.6.

- [ ] **Step 3: Run full test suite**

Run: `cd packages/expr && npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/expr/src/index.ts packages/expr/EXPR_SPEC.md
git commit -m "docs(expr): document \$.path sugar in EXPR_SPEC; export parseDollarPath"
```
