# Expr Evaluation Guardrails

**Date:** 2026-03-24
**Package:** `@durable-machines/expr` (step budget, expression complexity), gateway (context size)

## Summary

Three independent guardrails that protect the gateway from expensive or unbounded expression evaluation, motivated by the gateway-evaluates architecture where state machine transitions run in the HTTP request path.

| Guardrail | When | Where | Catches |
|-----------|------|-------|---------|
| Expression complexity | Definition time | Machine registration | Overly complex expressions |
| Step budget | Runtime | `evaluate()` / compiled closures | Explosive context × expr interactions |
| Context size | Post-evaluation | Gateway, before DB write | Unbounded context growth |

All three are optional, configurable, and backward compatible.

## Motivation

In the gateway-evaluates architecture, the gateway reads current machine state, evaluates the state machine transition in-memory, and writes results atomically — all in the webhook request path. A user-authored machine with expensive expressions or large context can block the request handler and hold a database lock. These guardrails bound evaluation cost at three layers: static analysis rejects obviously expensive definitions, a runtime step budget catches explosive data × expression interactions, and a post-evaluation size check prevents unbounded context growth.

## 1. Step Budget

### Design

A mutable counter on `Scope` that decrements at every evaluation step. When exhausted, evaluation throws `StepBudgetExceeded`.

```ts
export interface Scope {
  context: Record<string, unknown>;
  event: Record<string, unknown>;
  params: Record<string, unknown>;
  bindings: Record<string, unknown>;
  budget?: { remaining: number };
}
```

The `budget` field is optional. When absent, no counting occurs — backward compatible, unlimited evaluation. When present, every evaluation step decrements `budget.remaining` and throws when it reaches zero.

The budget is a mutable object reference. Inner scopes created by `let`, iteration operators, and `pipe` carry the same reference, so all nested evaluation shares one counter.

### Decrement points

Every place the evaluator does meaningful work must decrement:

1. **Top of `evaluate()`** — each recursive call is a step. This covers all operator dispatch in the interpreted path.

2. **Compiled closure invocations** — each closure returned by `compile()` must decrement when called at runtime. The closure captures a reference to `scope.budget` via the scope parameter it receives.

3. **Collection iteration callbacks** — `evaluateIteration()` (filter/map/every/some), `evaluateReduce()`, `evaluateMapVals()`, `evaluateFilterKeys()`, `evaluateDeepSelect()`. Each element processed is a step, in addition to the body evaluation steps.

4. **`where` predicate evaluation** — in `selectPath()` (lines 43-51) and `compilePathStep()` (compile.ts lines 268-281), each entry tested against the predicate costs a step.

5. **Transform fan-out** — in `applyOneTransform()` (transforms.ts lines 46-60), each matching entry that triggers a sub-transform costs a step.

6. **Compiled collection ops** — `compileIteration()`, `compileReduce()`, `compileDeepSelect()` runtime closures. Each element processed at runtime decrements.

### Step counting helper

A shared helper function avoids duplicating the check-and-throw logic:

```ts
export class StepBudgetExceeded extends Error {
  constructor() {
    super("Expression evaluation step budget exceeded");
    this.name = "StepBudgetExceeded";
  }
}

export function deductStep(scope: Scope): void {
  if (scope.budget !== undefined && --scope.budget.remaining < 0) {
    throw new StepBudgetExceeded();
  }
}
```

Every decrement point calls `deductStep(scope)`. The function is a no-op when `budget` is undefined.

### Default budget

Configured per deployment, not per machine definition. Reasonable starting point: **10,000 steps**. This is generous for typical machines (a complex cmi5 machine with 30 states and rich context evaluates in ~200 steps per event) but catches runaway evaluation.

### Error handling

`StepBudgetExceeded` propagates up the call stack to the gateway. The gateway catches it, rejects the event (HTTP 422 or similar), and releases any database lock. The machine state is unchanged — the event is not persisted.

### Scope creation

`createScope()` in `types.ts` gains an optional `budget` parameter:

```ts
export function createScope(
  context: Record<string, unknown>,
  event: Record<string, unknown>,
  params?: Record<string, unknown>,
  bindings?: Record<string, unknown>,
  budget?: { remaining: number },
): Scope
```

### Interaction with `selectPath`

`selectPath` resolves the root segment via explicit field checks (`context`, `event`, `params`, then bindings lookup). The `budget` field is not checked, so `$.budget` returns `undefined` — the budget is invisible to expressions.

## 2. Expression Complexity Limits

### Design

A `validateExprComplexity()` function that walks an expression tree at machine definition registration time and checks two metrics:

- **Operator count:** total operator nodes in the tree.
- **Max depth:** deepest nesting level.

```ts
export interface ComplexityResult {
  operatorCount: number;
  maxDepth: number;
}

export interface ComplexityLimits {
  maxOperatorCount: number;  // default: 500
  maxDepth: number;          // default: 15
}

export function validateExprComplexity(
  expr: Expr,
  limits: ComplexityLimits,
): ComplexityResult
```

Throws `ExprComplexityExceeded` if either metric exceeds its limit.

### Tree walk

Recursive depth-first walk. At each node:
- If the node is a primitive (string, number, boolean, null), it contributes 0 to operator count and 0 to depth.
- If the node is an object with a key in the operator set (per `isExprOperator()`), it contributes 1 to operator count and 1 to depth. Its operands are walked recursively.
- If the node is an array, each element is walked (arrays are operator arguments, not operators themselves).

The walk visits all sub-expressions including: operator arguments, `let` binding values and body, `object` field values, `cond` guard/value pairs, `pipe` stages, collection operation bodies, and transform `set`/`append` values.

### Where it runs

At machine definition registration — before the definition is stored. The registration endpoint walks all expressions in:
- Guard expressions on transitions
- Action expressions (assign transforms: `set`, `append` values; emit/raise event payloads)
- `let` bindings in actions
- `enqueueActions` nested action trees

If any single expression exceeds either limit, the definition is rejected with details: which expression, which metric, actual value vs limit.

### New file

`packages/expr/src/validate.ts` — keeps validation logic separate from evaluation and compilation.

### Error

```ts
export class ExprComplexityExceeded extends Error {
  operatorCount: number;
  maxDepth: number;
  limit: ComplexityLimits;
}
```

### Default limits

| Metric | Default | Rationale |
|--------|---------|-----------|
| Operator count | 500 | Typical complex expression: 20-50 operators. 500 is 10x headroom. |
| Max depth | 15 | Typical nesting: 3-5 levels. 15 allows `let` wrapping + nested conditionals + collection ops. |

## 3. Context Size Limit

### Design

After evaluation produces a new context via `applyTransforms()`, the gateway checks its serialized size before writing to the database. If the serialized context exceeds a configurable byte limit, the event is rejected.

```ts
const serialized = JSON.stringify(newContext);
const bytes = Buffer.byteLength(serialized, "utf8");
if (bytes > contextSizeLimit) {
  throw new ContextSizeLimitExceeded(bytes, contextSizeLimit);
}
```

### Where it runs

In the gateway, after state machine evaluation produces the new context and before the atomic DB write (INSERT event + UPDATE instance + INSERT effects). The event is rejected, no DB write occurs, state is unchanged.

### Error

```ts
export class ContextSizeLimitExceeded extends Error {
  actualBytes: number;
  limitBytes: number;
}
```

HTTP 422 response to the webhook caller with the size details.

### Default limit

**256 KB.** PostgreSQL JSONB values exceeding ~2KB are TOASTed, and practical machine contexts in cmi5 are 1-10KB. 256KB provides generous headroom while preventing megabyte-scale context growth.

### No DB constraint

The gateway is the sole writer of machine instance state, so the application-level check is sufficient. A DB-side `CHECK` constraint using `octet_length(context::text)` would require full serialization on every UPDATE — expensive and redundant.

## Semantic Preservation

All three guardrails are additive — they reject evaluation or definitions that would otherwise succeed, but do not change the semantics of evaluation that stays within limits. Existing machines and tests are unaffected when guardrails are not configured or when configured limits are not exceeded.

## Files Changed

| File | Change |
|------|--------|
| `packages/expr/src/types.ts` | Add `budget?: { remaining: number }` to `Scope`; update `createScope()`; add `StepBudgetExceeded` error class; add `deductStep()` helper |
| `packages/expr/src/evaluate.ts` | Call `deductStep(scope)` at top of `evaluate()`; call in `selectPath()` where loop and `resolveStep()` |
| `packages/expr/src/compile.ts` | Compiled closures call `deductStep(scope)` at runtime; compiled path step closures call `deductStep()` in where iteration |
| `packages/expr/src/eval-collection-ops.ts` | Call `deductStep(scope)` per element in iteration/reduce/mapVals/filterKeys/deepSelect |
| `packages/expr/src/compile-collection-ops.ts` | Runtime closures call `deductStep(scope)` per element |
| `packages/expr/src/transforms.ts` | Call `deductStep(scope)` per matching entry in where fan-out |
| `packages/expr/src/where.ts` | No changes — `matchesWhere()` receives scope which carries budget; step is counted by caller |
| `packages/expr/src/validate.ts` | **New file.** `validateExprComplexity()`, `ComplexityResult`, `ComplexityLimits`, `ExprComplexityExceeded` |
| `packages/expr/src/introspection.ts` | Export `EXPR_OPERATORS` set (currently private) for use by validate.ts |
| `packages/expr/src/index.ts` | Export validation functions and error classes |
| `packages/expr/EXPR_SPEC.md` | Add section on evaluation limits (step budget, complexity limits) |
| Gateway (future) | Context size check after evaluation, before DB write |

## Testing

### Step budget tests

- Budget decrements correctly through recursive `evaluate()` calls
- Budget decrements through compiled closure execution
- `StepBudgetExceeded` thrown when budget exhausted mid-evaluation
- `StepBudgetExceeded` thrown when budget exhausted in compiled path
- Budget shared across nested scopes (`let`, iteration inner scopes)
- Collection iteration (`filter`, `map`, `reduce`, `where`) each element costs a step
- `deepSelect` recursive traversal costs a step per node visited
- Transform fan-out costs a step per matching entry
- No budget (undefined) — unlimited evaluation, no error
- Budget of 0 — throws immediately
- Budget exactly sufficient — completes without throwing

### Expression complexity tests

- Simple expression: count 1, depth 1
- Nested expression: depth tracks correctly
- Wide expression (`and` with 10 operands): count 11, depth 2
- `let` with bindings: binding values and body all counted
- `object` with fields: each field value counted
- `cond` with branches: all guards and values counted
- Collection ops: body expression counted
- Exceeds operator count limit: throws with details
- Exceeds depth limit: throws with details
- Within limits: returns counts without throwing
- Primitive expressions (string, number, null): count 0, depth 0

### Context size tests

- Context under limit: no error
- Context over limit: throws `ContextSizeLimitExceeded` with actual and limit bytes
- Context exactly at limit: no error
- UTF-8 multi-byte characters counted correctly (byte length, not character length)

### Backward compatibility

- All existing tests pass without budget set (unlimited evaluation)
- `createScope()` without budget parameter works unchanged
- `evaluate()` and `compile()` behavior unchanged when no budget present
