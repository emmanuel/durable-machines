# `%.param` and `@.ref` Sigil-Dot Sugar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `%.name` string sugar for `param` lookups and `@.name` string sugar for `ref` (binding) lookups, following the sigil-dot pattern established by `$.path` sugar.

**Architecture:** Both sugars desugar at `evaluate()`/`compile()` entry (same approach as `$.` sugar). Parse/validation functions live in `desugar.ts`. Both work in expression context and as path steps. The `where.ts` `wrapIfString` function is updated to handle sigil strings before the default `{ ref: expr }` wrapping.

**Tech Stack:** TypeScript, Vitest, ESM (`.js` extension imports)

**Spec:** `docs/superpowers/specs/2026-03-19-param-ref-sigil-sugar-design.md`

**Prerequisite spec (for context):** `docs/superpowers/specs/2026-03-18-dollar-path-sugar-design.md`

**Note:** `packages/expr/EXPR_SPEC.md` was already updated with §3.3 Param Sugar, §3.4 Ref Sugar, path step table updates, and grammar updates in a prior commit. No EXPR_SPEC task needed in this plan.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/expr/src/desugar.ts` | Modify | Add `parseParamSugar`, `parseRefSugar` alongside existing `parseDollarPath` |
| `packages/expr/src/evaluate.ts` | Modify | Intercept `%.`/`@.` strings in `evaluate()` + `resolveStep()` |
| `packages/expr/src/compile.ts` | Modify | Intercept `%.`/`@.` strings in `compile()` + `compilePathStep()` |
| `packages/expr/src/where.ts` | Modify | Handle `%.`/`@.` in `wrapIfString()` |
| `packages/expr/src/index.ts` | Modify | Export `parseParamSugar`, `parseRefSugar` |
| `packages/expr/tests/unit/desugar.test.ts` | Modify | Add parse function tests |
| `packages/expr/tests/unit/evaluate.test.ts` | Modify | Add expression + path step + where tests |
| `packages/expr/tests/unit/compile.test.ts` | Modify | Add parity tests |
| `packages/expr/tests/unit/path.test.ts` | Modify | Add sigil path step tests in selectPath/transform context |

---

### Task 1: Parse Functions in `desugar.ts`

**Files:**
- Modify: `packages/expr/src/desugar.ts`
- Modify: `packages/expr/tests/unit/desugar.test.ts`

- [ ] **Step 1: Write failing tests for `parseParamSugar`**

In `packages/expr/tests/unit/desugar.test.ts`, update the existing import to add `parseParamSugar`:

```ts
import { parseDollarPath, parseParamSugar } from "../../src/desugar.js";
```

Then add the describe block after the existing `parseDollarPath` tests:

```ts
describe("parseParamSugar", () => {
  it("parses simple param name", () => {
    expect(parseParamSugar("%.auId")).toEqual({ param: "auId" });
  });

  it("parses hyphenated param name", () => {
    expect(parseParamSugar("%.foo-bar")).toEqual({ param: "foo-bar" });
  });

  it("throws on empty name", () => {
    expect(() => parseParamSugar("%.")).toThrow("Invalid param sugar");
  });

  it("throws on dots in name", () => {
    expect(() => parseParamSugar("%.foo.bar")).toThrow("Invalid param sugar");
  });
});
```

Note: Do NOT import `parseRefSugar` yet — it will be added in Step 5.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/expr && npx vitest run tests/unit/desugar.test.ts`
Expected: FAIL — `parseParamSugar` is not exported from `desugar.js`

- [ ] **Step 3: Implement `parseParamSugar`**

Add to `packages/expr/src/desugar.ts` after the existing `parseDollarPath` function:

```ts
/**
 * Parse a `%.name` sugar string into a `param` expression.
 *
 * @param s — a string starting with `%.` (e.g. `"%.auId"`)
 * @returns an object `{ param: string }` ready for evaluation
 * @throws if the name is empty or contains dots
 */
export function parseParamSugar(s: string): { param: string } {
  const name = s.slice(2); // strip "%."
  if (name === "" || name.includes(".")) {
    throw new Error(`Invalid param sugar: "${s}"`);
  }
  return { param: name };
}
```

- [ ] **Step 4: Run tests to verify `parseParamSugar` tests pass**

Run: `cd packages/expr && npx vitest run tests/unit/desugar.test.ts`
Expected: `parseParamSugar` tests PASS, `parseRefSugar` tests still FAIL (not yet implemented)

- [ ] **Step 5: Write failing tests for `parseRefSugar`**

In `packages/expr/tests/unit/desugar.test.ts`, update the import to add `parseRefSugar`:

```ts
import { parseDollarPath, parseParamSugar, parseRefSugar } from "../../src/desugar.js";
```

Then add the describe block:

```ts
describe("parseRefSugar", () => {
  it("parses simple ref name", () => {
    expect(parseRefSugar("@.score")).toEqual({ ref: "score" });
  });

  it("parses hyphenated ref name", () => {
    expect(parseRefSugar("@.my-binding")).toEqual({ ref: "my-binding" });
  });

  it("throws on empty name", () => {
    expect(() => parseRefSugar("@.")).toThrow("Invalid ref sugar");
  });

  it("throws on dots in name", () => {
    expect(() => parseRefSugar("@.foo.bar")).toThrow("Invalid ref sugar");
  });
});
```

- [ ] **Step 6: Implement `parseRefSugar`**

Add to `packages/expr/src/desugar.ts` after `parseParamSugar`:

```ts
/**
 * Parse a `@.name` sugar string into a `ref` expression.
 *
 * @param s — a string starting with `@.` (e.g. `"@.score"`)
 * @returns an object `{ ref: string }` ready for evaluation
 * @throws if the name is empty or contains dots
 */
export function parseRefSugar(s: string): { ref: string } {
  const name = s.slice(2); // strip "@."
  if (name === "" || name.includes(".")) {
    throw new Error(`Invalid ref sugar: "${s}"`);
  }
  return { ref: name };
}
```

- [ ] **Step 7: Run all desugar tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/desugar.test.ts`
Expected: ALL PASS (existing `parseDollarPath` tests + new tests)

- [ ] **Step 8: Commit**

```bash
git add packages/expr/src/desugar.ts packages/expr/tests/unit/desugar.test.ts
git commit -m "feat(expr): add parseParamSugar and parseRefSugar in desugar.ts"
```

---

### Task 2: Integrate into `evaluate.ts` (expression context)

**Files:**
- Modify: `packages/expr/src/evaluate.ts:1-7,104-107`
- Modify: `packages/expr/tests/unit/evaluate.test.ts`

**Context:** The string branch in `evaluate()` currently handles `$.` sugar at lines 104-106. We add `%.` and `@.` checks after the `$.` check but before the `return expr` fallthrough. Both resolve directly (no recursive `evaluate` call needed since `param` and `ref` are leaf operators).

- [ ] **Step 1: Write failing tests for `%.` and `@.` expression sugar**

Add to `packages/expr/tests/unit/evaluate.test.ts`:

```ts
describe("evaluate — %.param sugar", () => {
  it("%.auId resolves like { param: 'auId' }", () => {
    const scope = createScope({ context: {}, params: { auId: "au-1" } });
    expect(evaluate("%.auId", scope)).toBe("au-1");
    expect(evaluate("%.auId", scope)).toBe(evaluate({ param: "auId" }, scope));
  });

  it("%.missing returns undefined", () => {
    const scope = createScope({ context: {} });
    expect(evaluate("%.missing", scope)).toBeUndefined();
  });

  it("in operator position: { eq: ['$.event.auId', '%.auId'] }", () => {
    const scope = createScope({
      context: {},
      event: { auId: "au-1" },
      params: { auId: "au-1" },
    });
    expect(evaluate({ eq: ["$.event.auId", "%.auId"] }, scope)).toBe(true);
  });

  it("nested in object expr", () => {
    const scope = createScope({ context: {}, params: { auId: "au-1" } });
    expect(evaluate({ object: { id: "%.auId" } }, scope)).toEqual({ id: "au-1" });
  });

  it("% without dot is literal", () => {
    const scope = createScope({ context: {} });
    expect(evaluate("%notDot", scope)).toBe("%notDot");
  });

  it("bare % is literal", () => {
    const scope = createScope({ context: {} });
    expect(evaluate("%", scope)).toBe("%");
  });

  it("%. with invalid name throws", () => {
    const scope = createScope({ context: {} });
    expect(() => evaluate("%.", scope)).toThrow();
    expect(() => evaluate("%.foo.bar", scope)).toThrow();
  });
});

describe("evaluate — @.ref sugar", () => {
  it("@.score resolves like { ref: 'score' }", () => {
    const scope = createScope({ context: {} });
    scope.bindings.score = 85;
    expect(evaluate("@.score", scope)).toBe(85);
    expect(evaluate("@.score", scope)).toBe(evaluate({ ref: "score" }, scope));
  });

  it("@.missing returns undefined", () => {
    const scope = createScope({ context: {} });
    expect(evaluate("@.missing", scope)).toBeUndefined();
  });

  it("in operator position: { add: ['@.count', 1] }", () => {
    const scope = createScope({ context: {} });
    scope.bindings.count = 10;
    expect(evaluate({ add: ["@.count", 1] }, scope)).toBe(11);
  });

  it("in let body: { let: [{ total: '$.context.count' }, '@.total'] }", () => {
    const scope = createScope({ context: { count: 42 } });
    expect(evaluate({ let: [{ total: "$.context.count" }, "@.total"] }, scope)).toBe(42);
  });

  it("@ without dot is literal", () => {
    const scope = createScope({ context: {} });
    expect(evaluate("@notDot", scope)).toBe("@notDot");
  });

  it("bare @ is literal", () => {
    const scope = createScope({ context: {} });
    expect(evaluate("@", scope)).toBe("@");
  });

  it("@. with invalid name throws", () => {
    const scope = createScope({ context: {} });
    expect(() => evaluate("@.", scope)).toThrow();
    expect(() => evaluate("@.foo.bar", scope)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/expr && npx vitest run tests/unit/evaluate.test.ts -t "%.param sugar"`
Expected: FAIL — `"%.auId"` is returned as a string literal

- [ ] **Step 3: Implement `%.` and `@.` interception in `evaluate()`**

In `packages/expr/src/evaluate.ts`:

1. Update the import at line 7 to include the new functions:

```ts
import { parseDollarPath, parseParamSugar, parseRefSugar } from "./desugar.js";
```

2. Expand the string branch (currently lines 104-107) to:

```ts
  if (typeof expr === "string") {
    if (expr.startsWith("$.")) return evaluate(parseDollarPath(expr), scope, builtins);
    if (expr.startsWith("%.")) { const { param: name } = parseParamSugar(expr); return scope.params[name]; }
    if (expr.startsWith("@.")) { const { ref: name } = parseRefSugar(expr); return scope.bindings[name]; }
    return expr;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/evaluate.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expr/src/evaluate.ts packages/expr/tests/unit/evaluate.test.ts
git commit -m "feat(expr): intercept %.param and @.ref sugar in evaluate()"
```

---

### Task 3: Integrate into `compile.ts` (expression context)

**Files:**
- Modify: `packages/expr/src/compile.ts:1-6,18-21`
- Modify: `packages/expr/tests/unit/compile.test.ts`

**Context:** The string branch in `compile()` currently handles `$.` sugar at lines 18-21. Same pattern as evaluate: add `%.` and `@.` checks. The `compile.test.ts` file has a helper `expectCompiledMatchesEvaluated(expr, scope)` that verifies compiled output matches interpreted output — use this for parity testing.

- [ ] **Step 1: Write failing tests for `%.` and `@.` compile sugar**

Add to `packages/expr/tests/unit/compile.test.ts`:

```ts
describe("compile — %.param sugar", () => {
  it("%.auId resolves param", () => {
    const scope = createScope({ context: {}, params: { auId: "au-1" } });
    expect(compile("%.auId")(scope)).toBe("au-1");
    expectCompiledMatchesEvaluated("%.auId", scope);
  });

  it("%.missing returns undefined", () => {
    const scope = createScope({ context: {} });
    expect(compile("%.missing")(scope)).toBeUndefined();
  });

  it("in operator position: { eq: ['$.event.auId', '%.auId'] }", () => {
    const scope = createScope({
      context: {},
      event: { auId: "au-1" },
      params: { auId: "au-1" },
    });
    const expr = { eq: ["$.event.auId", "%.auId"] };
    expect(compile(expr)(scope)).toBe(true);
    expectCompiledMatchesEvaluated(expr, scope);
  });

  it("nested in object expr", () => {
    const scope = createScope({ context: {}, params: { auId: "au-1" } });
    const expr = { object: { id: "%.auId" } };
    expect(compile(expr)(scope)).toEqual({ id: "au-1" });
    expectCompiledMatchesEvaluated(expr, scope);
  });

  it("% without dot is literal", () => {
    const scope = createScope({ context: {} });
    expect(compile("%notDot")(scope)).toBe("%notDot");
    expect(compile("%")(scope)).toBe("%");
  });
});

describe("compile — @.ref sugar", () => {
  it("@.score resolves binding", () => {
    const scope = createScope({ context: {} });
    scope.bindings.score = 85;
    expect(compile("@.score")(scope)).toBe(85);
    expectCompiledMatchesEvaluated("@.score", scope);
  });

  it("@.missing returns undefined", () => {
    const scope = createScope({ context: {} });
    expect(compile("@.missing")(scope)).toBeUndefined();
  });

  it("in operator position: { add: ['@.count', 1] }", () => {
    const scope = createScope({ context: {} });
    scope.bindings.count = 10;
    const expr = { add: ["@.count", 1] };
    expect(compile(expr)(scope)).toBe(11);
    expectCompiledMatchesEvaluated(expr, scope);
  });

  it("in let body", () => {
    const scope = createScope({ context: { count: 42 } });
    const expr = { let: [{ total: "$.context.count" }, "@.total"] };
    expect(compile(expr)(scope)).toBe(42);
    expectCompiledMatchesEvaluated(expr, scope);
  });

  it("@ without dot is literal", () => {
    const scope = createScope({ context: {} });
    expect(compile("@notDot")(scope)).toBe("@notDot");
    expect(compile("@")(scope)).toBe("@");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/expr && npx vitest run tests/unit/compile.test.ts -t "%.param sugar"`
Expected: FAIL — `"%.auId"` returns the string literal

- [ ] **Step 3: Implement `%.` and `@.` interception in `compile()`**

In `packages/expr/src/compile.ts`:

1. Update the import at line 6 to include the new functions:

```ts
import { parseDollarPath, parseParamSugar, parseRefSugar } from "./desugar.js";
```

2. Expand the string branch (currently lines 18-21) to:

```ts
  if (typeof expr === "string") {
    if (expr.startsWith("$.")) return compile(parseDollarPath(expr), builtins);
    if (expr.startsWith("%.")) { const { param: name } = parseParamSugar(expr); return (s) => s.params[name]; }
    if (expr.startsWith("@.")) { const { ref: name } = parseRefSugar(expr); return (s) => s.bindings[name]; }
    return () => expr;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/compile.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expr/src/compile.ts packages/expr/tests/unit/compile.test.ts
git commit -m "feat(expr): intercept %.param and @.ref sugar in compile()"
```

---

### Task 4: Integrate into `resolveStep()` and `compilePathStep()` (path step context)

**Files:**
- Modify: `packages/expr/src/evaluate.ts:76-78`
- Modify: `packages/expr/src/compile.ts:224-225`
- Modify: `packages/expr/tests/unit/evaluate.test.ts`
- Modify: `packages/expr/tests/unit/compile.test.ts`
- Modify: `packages/expr/tests/unit/path.test.ts`

**Context:** `resolveStep()` in `evaluate.ts` resolves path step navigators to string keys. Currently, a string step at line 76-78 just returns the string as a static key. We add `%.`/`@.` prefix checks to resolve them as dynamic keys from params/bindings. Same pattern in `compilePathStep()` in `compile.ts` at line 225.

- [ ] **Step 1: Write failing tests for sigil path steps in evaluate**

Add to `packages/expr/tests/unit/evaluate.test.ts`:

```ts
describe("evaluate — %.param and @.ref as path steps", () => {
  it("%.auId as path step looks up param value as key", () => {
    const scope = createScope({
      context: { aus: { "au-1": { hasPassed: true } } },
      params: { auId: "au-1" },
    });
    expect(evaluate({ select: ["context", "aus", "%.auId", "hasPassed"] }, scope)).toBe(true);
    // Equivalent to { param: "auId" } object form:
    expect(evaluate({ select: ["context", "aus", "%.auId", "hasPassed"] }, scope)).toBe(
      evaluate({ select: ["context", "aus", { param: "auId" }, "hasPassed"] }, scope),
    );
  });

  it("@.sessionId as path step looks up binding value as key", () => {
    const scope = createScope({
      context: { sessions: { "s-1": { state: "active" } } },
    });
    scope.bindings.sessionId = "s-1";
    expect(evaluate({ select: ["context", "sessions", "@.sessionId", "state"] }, scope)).toBe("active");
    // Equivalent to { ref: "sessionId" } object form:
    expect(evaluate({ select: ["context", "sessions", "@.sessionId", "state"] }, scope)).toBe(
      evaluate({ select: ["context", "sessions", { ref: "sessionId" }, "state"] }, scope),
    );
  });

  it("%.missing param returns undefined", () => {
    const scope = createScope({ context: { items: { a: 1 } } });
    expect(evaluate({ select: ["context", "items", "%.missing"] }, scope)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/expr && npx vitest run tests/unit/evaluate.test.ts -t "as path steps"`
Expected: FAIL — `"%.auId"` is used as a literal key (looks up `context.aus["%.auId"]` which doesn't exist)

- [ ] **Step 3: Implement sigil path steps in `resolveStep()`**

In `packages/expr/src/evaluate.ts`, replace the string handler in `resolveStep()` (line 76-78):

Currently:
```ts
  if (typeof step === "string") {
    return step;
  }
```

Replace with:
```ts
  if (typeof step === "string") {
    if (step.startsWith("%.")) {
      const { param: name } = parseParamSugar(step);
      const val = scope.params[name];
      return val !== undefined ? String(val) : undefined;
    }
    if (step.startsWith("@.")) {
      const { ref: name } = parseRefSugar(step);
      const val = scope.bindings[name];
      return val !== undefined ? String(val) : undefined;
    }
    return step;
  }
```

- [ ] **Step 4: Run evaluate tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/evaluate.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Write failing compile path step tests**

Add to `packages/expr/tests/unit/compile.test.ts`:

```ts
describe("compile — %.param and @.ref as path steps", () => {
  it("%.auId as path step looks up param value as key", () => {
    const scope = createScope({
      context: { aus: { "au-1": { hasPassed: true } } },
      params: { auId: "au-1" },
    });
    const expr = { select: ["context", "aus", "%.auId", "hasPassed"] };
    expect(compile(expr)(scope)).toBe(true);
    expectCompiledMatchesEvaluated(expr, scope);
  });

  it("@.sessionId as path step looks up binding value as key", () => {
    const scope = createScope({
      context: { sessions: { "s-1": { state: "active" } } },
    });
    scope.bindings.sessionId = "s-1";
    const expr = { select: ["context", "sessions", "@.sessionId", "state"] };
    expect(compile(expr)(scope)).toBe("active");
    expectCompiledMatchesEvaluated(expr, scope);
  });

  it("%.missing param returns undefined", () => {
    const scope = createScope({ context: { items: { a: 1 } } });
    expect(compile({ select: ["context", "items", "%.missing"] })(scope)).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run compile tests to verify path step tests fail**

Run: `cd packages/expr && npx vitest run tests/unit/compile.test.ts -t "as path steps"`
Expected: FAIL — `"%.auId"` is used as a literal key in compiled path

- [ ] **Step 7: Implement sigil path steps in `compilePathStep()`**

In `packages/expr/src/compile.ts`, replace the string handler in `compilePathStep()` (line 225):

Currently:
```ts
  if (typeof step === "string") return (current) => current[step];
```

Replace with:
```ts
  if (typeof step === "string") {
    if (step.startsWith("%.")) {
      const { param: name } = parseParamSugar(step);
      return (current, scope) => {
        const key = scope.params[name];
        return key !== undefined ? current[String(key)] : undefined;
      };
    }
    if (step.startsWith("@.")) {
      const { ref: name } = parseRefSugar(step);
      return (current, scope) => {
        const key = scope.bindings[name];
        return key !== undefined ? current[String(key)] : undefined;
      };
    }
    return (current) => current[step];
  }
```

- [ ] **Step 8: Run compile tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/compile.test.ts`
Expected: ALL PASS

- [ ] **Step 9: Add path step tests to `path.test.ts`**

Add to `packages/expr/tests/unit/path.test.ts`. First, add to the imports at the top:

```ts
import { evaluate } from "../../src/evaluate.js";
```

Then add (note: `evaluate` may already be imported — check the file first):

```ts
describe("selectPath — sigil path steps", () => {
  it("%.param as path step in selectPath", () => {
    const scope = createScope({
      context: { aus: { "au-1": { score: 95 } } },
      params: { auId: "au-1" },
    });
    expect(selectPath(["context", "aus", "%.auId", "score"], scope)).toBe(95);
  });

  it("@.ref as path step in selectPath", () => {
    const scope = createScope({
      context: { sessions: { "s-1": { active: true } } },
    });
    scope.bindings.sid = "s-1";
    expect(selectPath(["context", "sessions", "@.sid", "active"], scope)).toBe(true);
  });
});
```

- [ ] **Step 10: Run path tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/path.test.ts`
Expected: ALL PASS (the path tests call `selectPath` which delegates to `resolveStep`, already updated)

- [ ] **Step 11: Commit**

```bash
git add packages/expr/src/evaluate.ts packages/expr/src/compile.ts packages/expr/tests/unit/evaluate.test.ts packages/expr/tests/unit/compile.test.ts packages/expr/tests/unit/path.test.ts
git commit -m "feat(expr): support %.param and @.ref sigil strings as path steps"
```

---

### Task 5: Update `where.ts` `wrapIfString`

**Files:**
- Modify: `packages/expr/src/where.ts:1-2,53-58`
- Modify: `packages/expr/tests/unit/evaluate.test.ts`
- Modify: `packages/expr/tests/unit/path.test.ts`

**Context:** `wrapIfString()` in `where.ts` rewrites bare strings in operator positions of `where` predicates. Currently it handles `$.` prefix (→ `parseDollarPath`) and falls through to `{ ref: expr }` for bare strings. We add `%.` and `@.` before the fallthrough. Note: using `%.` or `@.` in a `where` predicate operator position intentionally escapes the entry-field-reference convention — `"%.auId"` looks up `scope.params["auId"]`, not an entry field.

- [ ] **Step 1: Write failing tests for sigil sugar in `where` predicates**

Add to `packages/expr/tests/unit/evaluate.test.ts`:

Note: `wrapIfString` in `where.ts` only rewrites the **first** operand in binary comparisons. The sigil strings MUST be in the first operand position to test the `wrapIfString` code path. The second operand is left as-is and handled by `evaluate()`'s string branch.

```ts
describe("evaluate — %.param and @.ref in where predicates", () => {
  it("%.param in first operand position triggers wrapIfString", () => {
    const scope = createScope({
      context: {
        items: {
          a: { auId: "au-1", score: 80 },
          b: { auId: "au-2", score: 90 },
          c: { auId: "au-1", score: 70 },
        },
      },
      params: { targetAu: "au-1" },
    });
    // "%.targetAu" is in the FIRST operand — wrapIfString converts it to { param: "targetAu" }
    // "auId" is in the SECOND operand — left as literal "au-1" comparison value
    const result = evaluate(
      { select: ["context", "items", { where: { eq: ["%.targetAu", "au-1"] } }] },
      scope,
    );
    expect(result).toEqual({
      a: { auId: "au-1", score: 80 },
      c: { auId: "au-1", score: 70 },
    });
  });

  it("@.ref in first operand position triggers wrapIfString", () => {
    const scope = createScope({
      context: {
        items: {
          a: { status: "active", value: 1 },
          b: { status: "inactive", value: 2 },
        },
      },
    });
    scope.bindings.target = "active";
    // "@.target" is in the FIRST operand — wrapIfString converts it to { ref: "target" }
    const result = evaluate(
      { select: ["context", "items", { where: { eq: ["@.target", "active"] } }] },
      scope,
    );
    expect(result).toEqual({
      a: { status: "active", value: 1 },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/expr && npx vitest run tests/unit/evaluate.test.ts -t "in where predicates"`
Expected: FAIL — `"%.targetAu"` is wrapped as `{ ref: "%.targetAu" }` by `wrapIfString`, which looks up `bindings["%.targetAu"]` (doesn't exist) instead of `params["targetAu"]`

- [ ] **Step 3: Update `wrapIfString` in `where.ts`**

In `packages/expr/src/where.ts`:

1. Update the import at line 2:

```ts
import { parseDollarPath, parseParamSugar, parseRefSugar } from "./desugar.js";
```

2. Replace `wrapIfString` (lines 53-59):

```ts
function wrapIfString(expr: Expr): Expr {
  if (typeof expr === "string") {
    if (expr.startsWith("$.")) return parseDollarPath(expr);
    if (expr.startsWith("%.")) return parseParamSugar(expr);
    if (expr.startsWith("@.")) return parseRefSugar(expr);
    return { ref: expr };
  }
  return expr;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/evaluate.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Add where predicate test to `path.test.ts`**

Add to `packages/expr/tests/unit/path.test.ts`:

```ts
describe("selectPath — sigil sugar in where predicates", () => {
  it("%.param in where predicate first operand filters by param value", () => {
    const scope = createScope({
      context: {
        entries: {
          a: { type: "x", val: 1 },
          b: { type: "y", val: 2 },
        },
      },
      params: { filterType: "x" },
    });
    const result = selectPath(
      ["context", "entries", { where: { eq: ["%.filterType", "x"] } }],
      scope,
    );
    expect(result).toEqual({ a: { type: "x", val: 1 } });
  });
});
```

- [ ] **Step 6: Add compile parity tests for where predicates with sigil sugar**

Add to `packages/expr/tests/unit/compile.test.ts`:

```ts
describe("compile — %.param and @.ref in where predicates", () => {
  it("%.param in where predicate first operand (compile parity)", () => {
    const scope = createScope({
      context: {
        items: {
          a: { auId: "au-1", score: 80 },
          b: { auId: "au-2", score: 90 },
        },
      },
      params: { targetAu: "au-1" },
    });
    const expr = { select: ["context", "items", { where: { eq: ["%.targetAu", "au-1"] } }] };
    expect(compile(expr)(scope)).toEqual({ a: { auId: "au-1", score: 80 } });
    expectCompiledMatchesEvaluated(expr, scope);
  });

  it("@.ref in where predicate first operand (compile parity)", () => {
    const scope = createScope({
      context: {
        items: {
          a: { status: "active", value: 1 },
          b: { status: "inactive", value: 2 },
        },
      },
    });
    scope.bindings.target = "active";
    const expr = { select: ["context", "items", { where: { eq: ["@.target", "active"] } }] };
    expect(compile(expr)(scope)).toEqual({ a: { status: "active", value: 1 } });
    expectCompiledMatchesEvaluated(expr, scope);
  });
});
```

- [ ] **Step 7: Run all tests to verify they pass**

Run: `cd packages/expr && npx vitest run tests/unit/path.test.ts tests/unit/compile.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add packages/expr/src/where.ts packages/expr/tests/unit/evaluate.test.ts packages/expr/tests/unit/path.test.ts packages/expr/tests/unit/compile.test.ts
git commit -m "feat(expr): handle %.param and @.ref in where predicate wrapIfString"
```

---

### Task 6: Export from `index.ts` and run full test suite

**Files:**
- Modify: `packages/expr/src/index.ts:8`

- [ ] **Step 1: Add exports to `index.ts`**

In `packages/expr/src/index.ts`, update line 8 from:

```ts
export { parseDollarPath } from "./desugar.js";
```

to:

```ts
export { parseDollarPath, parseParamSugar, parseRefSugar } from "./desugar.js";
```

- [ ] **Step 2: Run the full test suite**

Run: `cd packages/expr && npx vitest run`
Expected: ALL tests pass (should be 383+ existing tests plus all new tests)

- [ ] **Step 3: Commit**

```bash
git add packages/expr/src/index.ts
git commit -m "feat(expr): export parseParamSugar and parseRefSugar from public API"
```
