# `$.` Dot-Path Sugar + `ref` Preservation

**Date:** 2026-03-18
**Package:** `@durable-machines/expr`
**Reference:** `statechart-rs` commits `b84ed79`, `2b0ffaa`

## Summary

Add `$.path` string sugar that desugars to `select` expressions. Keep `ref` as a distinct bindings-only operator (no scope widening) to preserve backward compatibility with `let`-bound names that shadow scope roots.

## Motivation

Currently, navigating scope values requires verbose JSON objects:

```json
{ "select": ["context", "count"] }
{ "select": ["event", "data", "userId"] }
```

The `$.` sugar allows the same expressions as plain strings:

```
"$.context.count"
"$.event.data.userId"
"$.myBinding"
```

## Desugaring Rules

| Input | Desugars to |
|-------|-------------|
| `"$.context.count"` | `{ select: ["context", "count"] }` |
| `"$.event.data.userId"` | `{ select: ["event", "data", "userId"] }` |
| `"$.myBinding"` | `{ select: ["myBinding"] }` |
| `"hello"` | `"hello"` (literal, unchanged) |
| `"$notDotPath"` | `"$notDotPath"` (literal, unchanged) |
| `"$"` | `"$"` (literal, unchanged — no dot after `$`) |

### Error Cases

| Input | Error |
|-------|-------|
| `"$."` | Invalid: empty path |
| `"$.context..foo"` | Invalid: empty segment |
| `"$.context."` | Invalid: trailing dot |

## Design

### Approach: Desugar at `evaluate()` / `compile()` entry

Both `evaluate()` and `compile()` intercept `$.` strings at the top of their dispatch logic, before the main operator chain. This is lazy (applied as the tree is walked), keeps both paths in sync, and requires no separate pre-processing pass.

### `ref` stays as bindings-only

Unlike `statechart-rs` (which eliminated `Ref` entirely), `{ ref: "x" }` remains a **bindings-only** lookup. This avoids a scope-widening semantic change that would break `let` bindings shadowing scope roots:

```json
{ "let": [{ "event": { "select": ["event", "type"] } }, { "ref": "event" }] }
```

Today this returns the `let`-bound value. If `ref` redirected through `selectPath`, it would return `scope.event` instead (since `selectPath` checks `context`/`event`/`params` before `bindings`).

The two forms have intentionally different semantics:
- `"$.x"` → `{ select: ["x"] }` → scope-wide lookup (context, event, params, bindings)
- `{ ref: "x" }` → bindings-only lookup

### New file: `packages/expr/src/desugar.ts`

Exports one function:

- **`parseDollarPath(s: string): { select: string[] }`** — Strips the `$.` prefix, splits on `.`, validates no empty segments, returns a `select` expression object.

Pure function with no dependencies on `evaluate` or `compile`.

### Integration Points

#### `evaluate.ts`

Line 103 currently handles string/number/boolean in a single compound check:

```ts
if (typeof expr === "string" || typeof expr === "number" || typeof expr === "boolean") return expr;
```

This needs to be split to intercept `$.` strings:

```ts
if (typeof expr === "string") {
  if (expr.startsWith("$.")) return evaluate(parseDollarPath(expr), scope, builtins);
  return expr;
}
if (typeof expr === "number" || typeof expr === "boolean") return expr;
```

The `ref` branch (line 144) stays unchanged:

```ts
if ("ref" in op) return scope.bindings[op.ref as string];
```

#### `compile.ts`

Same pattern. Line 17 splits the compound check:

```ts
if (typeof expr === "string") {
  if (expr.startsWith("$.")) return compile(parseDollarPath(expr), builtins);
  return () => expr;
}
if (typeof expr === "number" || typeof expr === "boolean") return () => expr;
```

The `ref` branch (line 49) stays unchanged:

```ts
if ("ref" in op) { const name = op.ref as string; return (s) => s.bindings[name]; }
```

#### `where.ts`

`wrapIfString()` currently wraps bare strings as `{ ref: "x" }`. Update to additionally handle `$.` strings by calling `parseDollarPath`. Bare field name strings keep using `{ ref: expr }` (bindings-only) to avoid scope-widening when entry fields collide with scope root names like `"context"`, `"event"`, or `"params"`:

```ts
function wrapIfString(expr: Expr): Expr {
  if (typeof expr === "string") {
    if (expr.startsWith("$.")) return parseDollarPath(expr);
    return { ref: expr };
  }
  return expr;
}
```

#### `introspection.ts`

Keep `"ref"` in the `EXPR_OPERATORS` set. `isExprOperator` is used to distinguish expr objects from plain data objects. Removing it would cause `{ ref: "x" }` to be treated as a non-expr passthrough in contexts that check `isExprOperator` before evaluating.

#### `resolveStep()` in `evaluate.ts`

No change. The `ref` branch in `resolveStep` (line 82) is a path-navigator context — `{ ref: "x" }` as a path step means "look up binding `x` and use its value as a key."

#### `PathNavigator` type in `types.ts`

No change. `{ ref: string }` remains a valid path navigator variant.

#### `compile-actions.ts` and `transforms.ts`

No code changes needed. These call `compile()` and `evaluate()` respectively, so `$.` strings in action expression positions (guard exprs, event payloads, `let` bindings, transform `set`/`append` values) are desugared transitively.

#### `actions.ts`

No code changes needed. Calls `evaluate()` for all expression positions.

### Interaction with `$` / `$index` / `$key` Bindings

The `pipe` operator binds intermediate values as `scope.bindings.$`. Collection operators bind `$index` and `$key`. These interact with `$.` sugar as follows:

| Sugar | Desugars to | Resolves via |
|-------|-------------|--------------|
| `"$.$"` | `{ select: ["$"] }` | `scope.bindings["$"]` (pipe accumulator) |
| `"$.$index"` | `{ select: ["$index"] }` | `scope.bindings["$index"]` (iteration index) |
| `"$.$key"` | `{ select: ["$key"] }` | `scope.bindings["$key"]` (mapVals/filterKeys key) |
| `"$"` | `"$"` (literal) | N/A — no dot after `$`, not sugar |

Bare `"$"` is **not** sugar. To reference the pipe accumulator with `$.` syntax, use `"$.$"`.

## Testing

### Unit Tests (desugar.ts)

- `parseDollarPath("$.context.count")` → `{ select: ["context", "count"] }`
- `parseDollarPath("$.x")` → `{ select: ["x"] }`
- `parseDollarPath("$.a.b.c.d")` → `{ select: ["a", "b", "c", "d"] }`
- `parseDollarPath("$.")` → throws
- `parseDollarPath("$.context..foo")` → throws
- `parseDollarPath("$.context.")` → throws

### Equivalence Tests (evaluate + compile)

- `"$.context.count"` produces same result as `{ select: ["context", "count"] }`
- `"$.event.output"` produces same result as `{ select: ["event", "output"] }`
- `"$.context"` returns the full context object
- Nested: `{ object: { x: "$.event.y" } }` evaluates correctly
- In `let` body: `{ let: [{ total: "$.context.count" }, "$.total"] }` works
- In collection ops: `{ filter: ["$.context.items", "item", { gt: ["$.item.score", 5] }] }` works

### Pipe / Special Binding Tests

- `"$.$"` inside a `pipe` resolves the pipe accumulator
- `"$.$index"` inside a `map` resolves the iteration index
- `"$.$key"` inside a `mapVals` resolves the current key

### `ref` Backward Compatibility

- `{ ref: "x" }` still resolves from bindings only
- `{ let: [{ event: "someValue" }, { ref: "event" }] }` returns `"someValue"` (not `scope.event`)
- `{ ref: "x" }` and `"$.x"` may differ when `x` shadows a scope root — this is intentional

### Compiler Parity

- All above tests pass through both `evaluate()` and `compile()` paths

### Existing Tests

- All existing tests continue passing unchanged

## Files Changed

| File | Change |
|------|--------|
| `packages/expr/src/desugar.ts` | **New.** `parseDollarPath` |
| `packages/expr/src/evaluate.ts` | Intercept `$.` strings at entry; split compound literal check |
| `packages/expr/src/compile.ts` | Intercept `$.` strings at entry; split compound literal check |
| `packages/expr/src/where.ts` | `wrapIfString` handles `$.` strings via `parseDollarPath`; bare strings keep `{ ref: x }` |
| `packages/expr/src/index.ts` | Export `parseDollarPath` from public API |
| `packages/expr/src/__tests__/` | New test file for dollar-path sugar + equivalence tests |
| `packages/expr/EXPR_SPEC.md` | Document `$.` sugar syntax |
| `packages/expr/src/compile-actions.ts` | No changes — benefits transitively from `compile()` interception |
| `packages/expr/src/transforms.ts` | No changes — benefits transitively from `evaluate()` interception |
| `packages/expr/src/actions.ts` | No changes — benefits transitively from `evaluate()` interception |
