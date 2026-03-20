# `%.param` and `@.ref` Sigil-Dot Sugar

**Date:** 2026-03-19
**Package:** `@durable-machines/expr`
**Prerequisite:** `$.path` sugar (shipped in `desugar.ts`, `evaluate.ts`, `compile.ts`)

## Summary

Add `%.name` string sugar for `param` lookups and `@.name` string sugar for `ref` (binding) lookups. Both follow the same sigil-dot pattern established by `$.path` sugar. Both also work as path step shorthand in `select` paths and transform paths.

## Motivation

After `$.path` sugar, the next most verbose patterns in JSON machine definitions are `{ param: "x" }` (~30 occurrences in a typical complex machine) and `{ ref: "x" }` (~40 occurrences). These are single-key objects that could be plain strings.

**Before:**
```json
{ "path": ["aus", { "param": "auId" }, "hasPassed"], "set": { "ref": "nextHasPassed" } }
{ "eq": [{ "select": ["event", "auId"] }, { "param": "auId" }] }
```

**After:**
```json
{ "path": ["aus", "%.auId", "hasPassed"], "set": "@.nextHasPassed" }
{ "eq": ["$.event.auId", "%.auId"] }
```

## Desugaring Rules

### Expression context

| Input | Desugars to |
|-------|-------------|
| `"%.auId"` | `{ param: "auId" }` |
| `"@.score"` | `{ ref: "score" }` |
| `"%"` | `"%"` (literal, unchanged — no dot) |
| `"@"` | `"@"` (literal, unchanged — no dot) |
| `"%notDot"` | `"%notDot"` (literal, unchanged — no dot after `%`) |
| `"@notDot"` | `"@notDot"` (literal, unchanged — no dot after `@`) |

### Error cases

| Input | Error |
|-------|-------|
| `"%."` | Invalid: empty name |
| `"@."` | Invalid: empty name |
| `"%.foo.bar"` | Invalid: params are flat, no dots in name |
| `"@.foo.bar"` | Invalid: bindings are flat, no dots in name |

### Path step context

Both sigils work as path navigators (in `select` paths and transform `path` arrays):

| Path step | Equivalent to |
|-----------|---------------|
| `"%.auId"` | `{ param: "auId" }` — looks up `scope.params["auId"]`, uses result as key |
| `"@.sessionId"` | `{ ref: "sessionId" }` — looks up `scope.bindings["sessionId"]`, uses result as key |
| `"staticKey"` | `"staticKey"` (unchanged — plain string static key) |

## Design

### New functions in `packages/expr/src/desugar.ts`

Add two functions alongside the existing `parseDollarPath`:

- **`parseParamSugar(s: string): { param: string }`** — Strips `%.` prefix, validates no dots in name, returns `{ param: name }`.
- **`parseRefSugar(s: string): { ref: string }`** — Strips `@.` prefix, validates no dots in name, returns `{ ref: name }`.

Both throw on empty name or dots in the name segment.

```ts
export function parseParamSugar(s: string): { param: string } {
  const name = s.slice(2); // strip "%."
  if (name === "" || name.includes(".")) {
    throw new Error(`Invalid param sugar: "${s}"`);
  }
  return { param: name };
}

export function parseRefSugar(s: string): { ref: string } {
  const name = s.slice(2); // strip "@."
  if (name === "" || name.includes(".")) {
    throw new Error(`Invalid ref sugar: "${s}"`);
  }
  return { ref: name };
}
```

### Sigil detection ordering

The three sigil prefixes are checked in order at the top of the string branch: `$.` first, then `%.`, then `@.`. They are **mutually exclusive** — a string can only match one prefix. Sigil prefixes inside `$.` path segments are NOT recognized (e.g., `"$.%.auId"` desugars to `{ select: ["%.auId"] }`, not to a param lookup).

### Integration: `evaluate.ts`

The string handling branch (currently lines 104-107) expands:

```ts
if (typeof expr === "string") {
  if (expr.startsWith("$.")) return evaluate(parseDollarPath(expr), scope, builtins);
  if (expr.startsWith("%.")) return scope.params[(expr.slice(2))]; // after validation
  if (expr.startsWith("@.")) return scope.bindings[(expr.slice(2))]; // after validation
  return expr;
}
```

Implementation note: For `%.` and `@.`, we can either desugar to the operator object and re-enter `evaluate()`, or resolve directly. Direct resolution is simpler and avoids an extra recursive call since `param` and `ref` are leaf operators (no sub-expressions). Either approach is correct; direct resolution is preferred for efficiency.

Actual implementation: call `parseParamSugar`/`parseRefSugar` for validation, then resolve directly:

```ts
if (expr.startsWith("%.")) { const { param: name } = parseParamSugar(expr); return scope.params[name]; }
if (expr.startsWith("@.")) { const { ref: name } = parseRefSugar(expr); return scope.bindings[name]; }
```

### Integration: `compile.ts`

Same pattern. The string branch expands:

```ts
if (expr.startsWith("%.")) { const { param: name } = parseParamSugar(expr); return (s) => s.params[name]; }
if (expr.startsWith("@.")) { const { ref: name } = parseRefSugar(expr); return (s) => s.bindings[name]; }
```

### Integration: `resolveStep()` in `evaluate.ts`

The string path step handler currently just returns the string as a static key. Add prefix checks, using the parse functions for validation:

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

### Integration: `compilePathStep()` in `compile.ts`

Same pattern for the compiled path step handler, using parse functions for validation:

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

### Integration: `where.ts` `wrapIfString`

Add `%.` and `@.` handling before the default `{ ref: expr }` wrapping:

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

Note: `wrapIfString` is called from `rewriteWhereStrings` in operator positions of `where` predicates. Bare strings without sigils wrap as `{ ref: expr }`, resolving from bindings (populated with the entry's fields in `where` context). Using `%.` or `@.` in a `where` predicate operator position intentionally escapes the entry-field-reference convention — `"%.auId"` looks up `scope.params["auId"]`, not an entry field. This is useful for comparing entry fields against machine params or outer bindings.

### Integration: `index.ts`

Export `parseParamSugar` and `parseRefSugar` from public API.

### No changes needed

- `introspection.ts` — `param` and `ref` stay in operator set
- `types.ts` — `PathNavigator` type already accepts `string` (static keys); sigil strings are just strings
- `actions.ts`, `compile-actions.ts`, `transforms.ts` — benefit transitively

## Semantic Preservation

- `"%.x"` → `{ param: "x" }` → `scope.params[x]` — unchanged semantics
- `"@.x"` → `{ ref: "x" }` → `scope.bindings[x]` — unchanged semantics (bindings-only, NOT scope-wide like `$.x`)
- `{ param: "x" }` and `{ ref: "x" }` object forms continue to work unchanged

## Testing

### Unit tests (desugar.ts)

- `parseParamSugar("%.auId")` → `{ param: "auId" }`
- `parseParamSugar("%.foo-bar")` → `{ param: "foo-bar" }` (hyphens OK)
- `parseParamSugar("%.")` → throws (empty name)
- `parseParamSugar("%.foo.bar")` → throws (dots in name)
- `parseRefSugar("@.score")` → `{ ref: "score" }`
- `parseRefSugar("@.")` → throws (empty name)
- `parseRefSugar("@.foo.bar")` → throws (dots in name)

### Equivalence tests (evaluate + compile)

- `"%.auId"` produces same result as `{ param: "auId" }`
- `"@.score"` produces same result as `{ ref: "score" }`
- `"%.x"` in operator position: `{ eq: ["$.event.auId", "%.auId"] }` works
- `"@.x"` in operator position: `{ add: ["@.count", 1] }` works
- Nested in `object`: `{ object: { id: "%.auId", value: "@.total" } }` works
- In `let` body: `{ let: [{ total: "$.context.count" }, "@.total"] }` works

### Path step tests

- `{ select: ["context", "aus", "%.auId"] }` — param as path step
- `{ select: ["context", "sessions", "@.sessionId"] }` — ref as path step
- Both produce same results as `{ param: "x" }` and `{ ref: "x" }` object path steps
- Both work in compile path too

### Where predicate tests

- `{ select: ["context", "aus", { where: { eq: ["%.auId", "au-123"] } }] }` — param sugar in where predicate
- `{ select: ["context", "items", { where: { eq: ["@.target", "x"] } }] }` — ref sugar in where predicate
- Both produce same results as `{ param: "x" }` and `{ ref: "x" }` object forms in where predicates

### Compiler parity

- All above tests pass through both `evaluate()` and `compile()` paths

### Backward compatibility

- `{ param: "x" }` and `{ ref: "x" }` object forms still work
- Plain strings without sigil prefixes are unaffected
- `"%"` and `"@"` without dots are literals

## Files Changed

| File | Change |
|------|--------|
| `packages/expr/src/desugar.ts` | Add `parseParamSugar`, `parseRefSugar` |
| `packages/expr/src/evaluate.ts` | Intercept `%.` and `@.` strings; update `resolveStep` for sigil path steps |
| `packages/expr/src/compile.ts` | Intercept `%.` and `@.` strings; update `compilePathStep` for sigil path steps |
| `packages/expr/src/where.ts` | `wrapIfString` handles `%.` and `@.` strings |
| `packages/expr/src/index.ts` | Export `parseParamSugar`, `parseRefSugar` |
| `packages/expr/tests/unit/desugar.test.ts` | Tests for parse functions |
| `packages/expr/tests/unit/evaluate.test.ts` | Expression + path step tests |
| `packages/expr/tests/unit/compile.test.ts` | Expression + path step + parity tests |
| `packages/expr/tests/unit/path.test.ts` | Path step tests in selectPath context |
| `packages/expr/EXPR_SPEC.md` | Document `%.` and `@.` sugar |
| `packages/expr/src/compile-actions.ts` | No changes — transitive |
| `packages/expr/src/transforms.ts` | No changes — transitive |
| `packages/expr/src/actions.ts` | No changes — transitive |
