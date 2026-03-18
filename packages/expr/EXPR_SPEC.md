# Expr Language Specification

This document is the complete specification for the `@durable-xstate/expr` expression language. It is sufficient to produce a conforming implementation in any programming language.

---

## 1. Data Model

All expressions and their inputs/outputs are JSON-compatible values:

- **null** (JSON null)
- **boolean** (true, false)
- **number** (IEEE 754 double-precision float)
- **string** (UTF-8)
- **array** (ordered sequence of values)
- **object** (unordered string-keyed map of values)
- **undefined** (the absent-value sentinel; not representable in JSON but used internally)

The language has no side effects. Evaluation of any expression is a pure function of the expression and the scope, with one exception: builtin functions may be impure (e.g., `uuid` generates random values, `now` reads the clock).

---

## 2. Scope

Every expression evaluates against a **scope**, a record with four fields:

| Field | Type | Description |
|-------|------|-------------|
| `context` | object | The machine's persistent state data |
| `event` | object | The current event payload (defaults to `{}`) |
| `params` | object | Static parameters (defaults to `{}`) |
| `bindings` | object | Named values introduced by `let`, iteration operators, and `pipe` (starts empty) |

Scopes are immutable. Operators that introduce bindings create a new scope with the original's fields shallow-copied and new bindings merged in. The original scope is never mutated.

---

## 3. Evaluation Rules

### 3.1 Literals

| Input type | Result |
|------------|--------|
| null | null |
| undefined | undefined |
| boolean | the same boolean |
| number | the same number |
| string | the same string |
| array | the same array (returned as-is, not copied) |

### 3.2 Operator Objects

If the input is an object (not null, not an array), it is checked for recognized operator keys. The **first** matching key determines which operator handles it. Operator key matching uses insertion order of the keys in the object.

If no recognized operator key is found, the object is returned unchanged.

### 3.3 Recognized Operator Keys

Listed in evaluation priority order:

`select`, `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `and`, `or`, `not`, `if`, `cond`, `in`, `ref`, `param`, `let`, `coalesce`, `isNull`, `add`, `sub`, `mul`, `div`, `object`, `len`, `at`, `merge`, `concat`, `filter`, `map`, `every`, `some`, `reduce`, `mapVals`, `filterKeys`, `deepSelect`, `pipe`, `pick`, `prepend`, `multiSelect`, `condPath`, `fn`

### 3.4 Truthiness

Several operators coerce values to boolean. The rule is the standard JavaScript truthiness test: `null`, `undefined`, `false`, `0`, `NaN`, and `""` are falsy; everything else is truthy.

### 3.5 Error Handling

There are no exceptions. Type mismatches produce default values rather than errors:

- Navigating into null/undefined/non-object → `undefined`
- Arithmetic on non-numbers → `NaN`
- Array operations on non-arrays → `[]` (for filter/map), `false` (for every/some)
- Object operations on non-objects → `{}`
- Unknown builtin function → `undefined`

---

## 4. Operators

### 4.1 Path Navigation — `select`

**Syntax:** `{ "select": path }`
**Path:** An array of path steps.

**Root resolution:** The first element of the path must be a string. It is resolved as:
1. `"context"` → `scope.context`
2. `"event"` → `scope.event`
3. `"params"` → `scope.params`
4. Any other string → look up in `scope.bindings`; if the key exists, use its value
5. Otherwise → `undefined`

**Step navigation:** Each subsequent step navigates one level deeper. If the current value is null, undefined, or not an object at any point, navigation terminates and returns `undefined`.

**Step types:**

| Step shape | Resolution |
|------------|------------|
| `"key"` (string) | Property lookup: `current[key]` |
| `{ "param": "name" }` | Look up `scope.params[name]`, coerce to string, use as key. If the param value is undefined, return `undefined`. |
| `{ "ref": "name" }` | Look up `scope.bindings[name]`, coerce to string, use as key. If the binding value is undefined, return `undefined`. |
| `{ "where": predicate }` | See §4.1.1 |
| `{ "all": true }`, `{ "first": true }`, `{ "last": true }` | Reserved collection navigators. Currently return `undefined`. |
| Any other object | Evaluate the object as an expression. Coerce the result to string and use as key. If result is null or undefined, return `undefined`. |

#### 4.1.1 The `where` Navigator

**Syntax (as a path step):** `{ "where": predicate }`

Applies to the current value, which must be an object. Iterates over the object's entries. For each entry whose value is an object, the value's fields are injected into `scope.bindings` (shallow merge). The predicate is then evaluated in this extended scope. Entries where the predicate is truthy are kept; others are excluded. The result is a new object containing only the matching entries.

**String rewriting in `where` predicates:** Before evaluation, bare strings in operator positions are rewritten to `{ "ref": string }`:
- In binary comparisons (`eq`, `neq`, `gt`, `lt`, `gte`, `lte`): only the **first** operand is rewritten (the second is treated as a literal comparison value)
- In `in`: only the **first** operand (the value to check) is rewritten (the second, the array, is left as-is)
- In `and`, `or`: recursively rewrite each sub-expression
- In `not`: recursively rewrite the operand
- All other expressions are left unchanged

**Example:** `{ "where": { "eq": ["status", "active"] } }` is rewritten to `{ "where": { "eq": [{ "ref": "status" }, "active"] } }` before evaluation.

### 4.2 Comparisons

All take a 2-element array `[left, right]`. Both operands are evaluated.

| Operator | Semantics |
|----------|-----------|
| `eq` | Strict identity comparison (===). No type coercion. |
| `neq` | Strict non-identity (!==). |
| `gt` | `left > right` — both operands treated as numbers. |
| `lt` | `left < right` — both operands treated as numbers. |
| `gte` | `left >= right` — both operands treated as numbers. |
| `lte` | `left <= right` — both operands treated as numbers. |

### 4.3 Logic

#### `and`
**Syntax:** `{ "and": [expr, ...] }`
Evaluate each expression in order. Return `true` if all are truthy, `false` otherwise. Short-circuit: stop at the first falsy value.

#### `or`
**Syntax:** `{ "or": [expr, ...] }`
Evaluate each expression in order. Return `true` if any is truthy, `false` otherwise. Short-circuit: stop at the first truthy value.

#### `not`
**Syntax:** `{ "not": expr }`
Evaluate the operand and return its boolean negation.

#### `if`
**Syntax:** `{ "if": [condition, thenExpr, elseExpr] }`
Evaluate `condition`. If truthy, evaluate and return `thenExpr`. Otherwise, evaluate and return `elseExpr`. Only the selected branch is evaluated.

#### `cond`
**Syntax:** `{ "cond": [[guard1, value1], [guard2, value2], ...] }`
Evaluate guards in order. For the first truthy guard, evaluate and return the corresponding value. If no guard is truthy, return `undefined`. Only the matched branch's value expression is evaluated.

### 4.4 Membership — `in`

**Syntax:** `{ "in": [valueExpr, arrayExpr] }`
Evaluate both operands. If the second operand is an array, return `true` if the array contains the first operand (using strict equality). If the second operand is not an array, return `false`.

### 4.5 Bindings

#### `ref`
**Syntax:** `{ "ref": "name" }`
Return `scope.bindings[name]`. If the key does not exist, return `undefined`.

#### `param`
**Syntax:** `{ "param": "name" }`
Return `scope.params[name]`. If the key does not exist, return `undefined`.

#### `let`
**Syntax:** `{ "let": [bindingsObject, bodyExpr] }`

1. Create a new scope with a copy of the current bindings.
2. Iterate over `bindingsObject` entries in insertion order.
3. For each entry `(name, expr)`: evaluate `expr` in the **current** new scope (so later bindings can reference earlier ones), then set `bindings[name]` to the result.
4. Evaluate `bodyExpr` in the new scope and return its result.

### 4.6 Nullability

#### `coalesce`
**Syntax:** `{ "coalesce": [expr1, expr2, ...] }`
Evaluate each expression in order. Return the first result that is neither null nor undefined. If all are null/undefined, return `undefined`.

#### `isNull`
**Syntax:** `{ "isNull": expr }`
Evaluate the operand. Return `true` if the result is null or undefined, `false` otherwise. Uses loose equality (`== null`) so both null and undefined produce `true`.

### 4.7 Arithmetic

All take a 2-element array `[left, right]`. Both operands are evaluated and treated as numbers.

| Operator | Semantics |
|----------|-----------|
| `add` | `left + right` |
| `sub` | `left - right` |
| `mul` | `left * right` |
| `div` | `left / right` (division by zero → `Infinity` or `NaN` per IEEE 754) |

### 4.8 Object Construction — `object`

**Syntax:** `{ "object": { key1: expr1, key2: expr2, ... } }`
Evaluate each value expression and return a new object with the same keys. Keys are literal strings (not evaluated).

### 4.9 Length — `len`

**Syntax:** `{ "len": expr }`
Evaluate the operand and return:
- If array: the array's length
- If string: the string's length (number of UTF-16 code units)
- If non-null object: the number of own enumerable keys
- Otherwise: `0`

### 4.10 Array Index — `at`

**Syntax:** `{ "at": [arrayExpr, indexExpr] }`
Evaluate both operands. If the first is not an array, return `undefined`. Otherwise, use the index with `Array.at()` semantics:
- Non-negative index: return element at that position (0-based), or `undefined` if out of bounds
- Negative index: count from the end (`-1` = last element, `-2` = second-to-last, etc.)

### 4.11 Object Merge — `merge`

**Syntax:** `{ "merge": [expr1, expr2, ...] }`
Evaluate each operand. Start with an empty object. For each result that is a non-null, non-array object, shallow-merge its entries into the accumulator. Later entries overwrite earlier ones for the same key. Non-object results are skipped.

### 4.12 Array Concatenation — `concat`

**Syntax:** `{ "concat": [expr1, expr2, ...] }`
Evaluate each operand. Build a result array by iterating over the evaluated values: if a value is an array, append all its elements to the result; if a value is not an array, append the value itself as a single element. This matches `Array.prototype.concat` semantics.

An empty operand list returns `[]`.

### 4.13 Object Key Selection — `pick`

**Syntax:** `{ "pick": [objectExpr, keysExpr] }`
Evaluate both operands. If the first is not a non-null, non-array object, or the second is not an array, return `{}`. Otherwise, return a new object containing only the keys from the keys array that exist in the source object.

### 4.14 Array Prepend — `prepend`

**Syntax:** `{ "prepend": [arrayExpr, valueExpr] }`
Evaluate both operands. If the first is an array, return a new array with the value prepended. If the first is not an array, return `[value]`.

### 4.15 Multi-Select — `multiSelect`

**Syntax:** `{ "multiSelect": [expr1, expr2, ...] }`
Evaluate each expression and return an array of the results.

### 4.16 Builtins — `fn`

**Syntax:** `{ "fn": ["name", arg1, arg2, ...] }`
Look up `name` in the builtin registry. If not found, return `undefined`. Otherwise, evaluate each argument expression, then call the builtin function with the evaluated arguments and return its result.

---

## 5. Collection Operators

All collection operators that iterate over arrays or objects support **dual arity**:

- **Eager form** (3-element tuple): `[collectionExpr, "bindName", bodyExpr]` — the collection is explicitly provided as the first element
- **Transducer form** (2-element tuple): `["bindName", bodyExpr]` — the collection is read from `scope.bindings.$`

**Arity detection:** If the first element of the tuple is a string, it is the transducer form (the string is the bind name). If the first element is not a string, it is the eager form (the first element is the collection expression).

### 5.1 Array Iteration

For each operator below, evaluation proceeds as follows:
1. Resolve the collection (from the explicit expression or from `$` binding)
2. If the collection is not an array, return the default value (see table below)
3. Iterate over the array. For each element at index `i`, create a new scope with:
   - `bindings[bindName]` = the current element
   - `bindings["$index"]` = `i` (zero-based integer)

| Operator | Body semantics | Non-array default |
|----------|---------------|-------------------|
| `filter` | Keep element if body is truthy | `[]` |
| `map` | Replace element with body result | `[]` |
| `every` | Return `false` at first falsy body | `false` |
| `some` | Return `true` at first truthy body | `false` |

For `every`: an empty array returns `false`.
For `some`: an empty array returns `false`.

### 5.2 Reduce

**Syntax (4 forms):**

| Form | Tuple | Collection source |
|------|-------|-------------------|
| Eager + init | `[arrayExpr, "accName", "itemName", bodyExpr, initExpr]` | explicit |
| Eager, no init | `[arrayExpr, "accName", "itemName", bodyExpr]` | explicit |
| Transducer + init | `["accName", "itemName", bodyExpr, initExpr]` | `$` binding |
| Transducer, no init | `["accName", "itemName", bodyExpr]` | `$` binding |

**Arity detection:** Same rule — if the first element is a string, it's transducer form. For eager form, init presence is determined by tuple length (5 = init, 4 = no init). For transducer form, tuple length 4 = init, 3 = no init.

**Evaluation:**
1. Resolve the collection. If not an array or is empty:
   - If init is present: evaluate `initExpr` and return its value
   - If init is absent: return `undefined`
2. Initialize the accumulator:
   - If init is present: evaluate `initExpr`, start iteration at index 0
   - If init is absent: use the first element as the accumulator, start iteration at index 1
3. For each element at index `i` (starting from start index):
   - Create a new scope with `bindings[accName]` = current accumulator, `bindings[itemName]` = current element, `bindings["$index"]` = `i`
   - Evaluate `bodyExpr` in this scope; the result becomes the new accumulator
4. Return the final accumulator value

### 5.3 Object Iteration

#### `mapVals`

**Syntax:** `{ "mapVals": [objExpr, "bindName", bodyExpr] }` or `{ "mapVals": ["bindName", bodyExpr] }`

If the resolved value is not a non-null, non-array object, return `{}`. Otherwise, iterate over the object's entries. For each entry `(key, value)`:
- Create a new scope with `bindings[bindName]` = `value`, `bindings["$key"]` = `key`
- Evaluate `bodyExpr` in this scope
- The result becomes the new value for `key` in the output object

Return the new object (same keys, transformed values).

#### `filterKeys`

**Syntax:** `{ "filterKeys": [objExpr, "bindName", predExpr] }` or `{ "filterKeys": ["bindName", predExpr] }`

Same as `mapVals`, but instead of transforming values, the predicate determines inclusion: if the body is truthy, the entry (with its original value) is included in the output. If falsy, it is excluded.

### 5.4 Deep Select — `deepSelect`

**Syntax:** `{ "deepSelect": [sourceExpr, "bindName", predExpr] }` or `{ "deepSelect": ["bindName", predExpr] }`

Performs a depth-first walk of the source value. At each node:
1. Create a new scope with `bindings[bindName]` = the current node
2. Evaluate `predExpr`. If truthy, add the node to the results array.
3. Recurse into children:
   - If the node is an array: recurse into each element
   - If the node is a non-null object: recurse into each value (not keys)
   - Otherwise: no children (leaf node)

Note: the predicate is tested **before** recursing into children. A matching parent does not prevent its children from also being tested and potentially matched.

Return a flat array of all matching nodes, in depth-first encounter order.

---

## 6. Composition Operators

### 6.1 Pipe — `pipe`

**Syntax:** `{ "pipe": [expr1, expr2, ...] }`

1. If the array is empty, return `undefined`.
2. Evaluate `expr1` in the current scope. Let the result be `current`.
3. For each subsequent expression `exprN`:
   - Create a new scope with `bindings["$"]` = `current`
   - Evaluate `exprN` in this scope
   - The result becomes the new `current`
4. Return the final `current`.

This enables transducer-form operators to compose naturally: each step receives the previous step's output via the `$` binding.

### 6.2 Conditional Path — `condPath`

**Syntax:** `{ "condPath": [inputExpr, [guard1, result1], [guard2, result2], ...] }`

1. Evaluate `inputExpr`. Let the result be `input`.
2. Create a new scope with `bindings["$"]` = `input`.
3. Evaluate each guard in order. For the first truthy guard, evaluate and return the corresponding result expression (in the same scope with `$` bound).
4. If no guard is truthy, return `undefined`.

---

## 7. Actions

Actions are declarative definitions for state machine side effects. They are evaluated against a scope and produce an array of **action results**.

### 7.1 Action Result Types

| Result type | Fields |
|-------------|--------|
| `assign` | `type: "assign"`, `context: object` (the new context) |
| `emit` | `type: "emit"`, `event: object` (the event payload) |
| `raise` | `type: "raise"`, `event: object`, optionally `delay: number`, `id: string` |

### 7.2 Assign Action

**Schema:**
```
{
  "type": "assign",
  "let": { ... },        // optional: binding definitions
  "transforms": [ ... ]  // required: array of transforms
}
```

**Evaluation:**
1. If `let` is present, evaluate bindings (see §4.5 `let` semantics) to create an extended scope.
2. Deep-clone the current `scope.context`.
3. Apply each transform (see §7.6) to the cloned context in order.
4. Return `{ type: "assign", context: clonedContext }`.

### 7.3 Emit Action

**Schema:**
```
{
  "type": "emit",
  "event": { key: expr, ... }
}
```

**Evaluation:** Evaluate each value in the event object. Return `{ type: "emit", event: evaluatedObject }`.

### 7.4 Raise Action

**Schema:**
```
{
  "type": "raise",
  "event": { key: expr, ... },
  "delay": expr,    // optional: delay in milliseconds
  "id": "string"    // optional: static cancellation ID
}
```

**Evaluation:** Evaluate the event payload. If `delay` is present, evaluate it as a number. Return `{ type: "raise", event, delay?, id? }`.

### 7.5 Enqueue Actions

**Schema:**
```
{
  "type": "enqueueActions",
  "let": { ... },                     // optional
  "actions": [ actionOrGuardedBlock, ... ]
}
```

**Guarded block schema:**
```
{
  "guard": expr,
  "actions": [ action, ... ]
}
```

A guarded block is distinguished from an action by having `guard` and `actions` keys but no `type` key.

**Evaluation:**
1. If `let` is present, evaluate bindings to create an extended scope.
2. Initialize an empty results array and a mutable scope reference.
3. For each entry in `actions`:
   - If it is a guarded block: evaluate the guard. If falsy, skip. If truthy, recursively evaluate each action in the block.
   - If it is an action: evaluate it.
4. **Context chaining:** After each `assign` result, update the scope's `context` to the new context from that result. Subsequent actions see the updated context. This ensures sequential assigns compose correctly.
5. Return all collected results.

### 7.6 Transforms

A transform applies a mutation to a context object at a specified path.

**Schema:**
```
{
  "path": [ pathStep, ... ],
  "set": expr,       // mutually exclusive
  "append": expr,    // mutually exclusive
  "remove": true     // mutually exclusive
}
```

**Path navigation for transforms:**
- Navigate to the parent of the target (all steps except the last)
- The last step is the leaf key where the mutation is applied

**Transform operations:**

| Operation | Semantics |
|-----------|-----------|
| `set` | Evaluate the expression and assign the result to `parent[leafKey]`. If intermediate path segments don't exist, create empty objects for `set` operations only. |
| `append` | Evaluate the expression. If `parent[leafKey]` is an array, push the value onto it. If it is not an array, no-op. |
| `remove` | Delete `parent[leafKey]`. |

**Fan-out with `where`:** If a `where` navigator appears in the parent path, the transform fans out: for each matching entry, the remaining path is navigated and the operation is applied. This allows a single transform to update multiple entries.

**Immutability:** Transforms operate on a deep clone of the context. The original context is never mutated.

---

## 8. Special Bindings

These bindings are introduced automatically by specific operators. They are injected into `scope.bindings` and can be accessed via `{ "ref": "name" }`.

| Binding | Introduced by | Value |
|---------|---------------|-------|
| `$` | `pipe` (§6.1), `condPath` (§6.2), transducer-form collection operators | The current value being threaded through the pipeline |
| `$index` | `filter`, `map`, `every`, `some`, `reduce` (§5.1, §5.2) | Zero-based integer index of the current element |
| `$key` | `mapVals`, `filterKeys` (§5.3) | String key of the current object entry |

Bindings introduced by inner scopes shadow bindings of the same name in outer scopes. When the inner scope is exited, the original bindings are restored (since scopes are immutable copies).

---

## 9. Builtin Functions

Builtin functions are provided via an external registry (an object mapping string names to functions). They are invoked by the `fn` operator.

### 9.1 Default Builtins

Conforming implementations should provide these default builtins:

#### `uuid()`
Returns a random UUID v4 string (e.g., `"550e8400-e29b-41d4-a716-446655440000"`).

#### `now()`
Returns the current Unix timestamp in milliseconds as a number (e.g., `1711234567890`).

#### `iso8601Duration(startISO, endISO)`
Given two ISO 8601 timestamp strings, compute the duration between them and return an ISO 8601 duration string in seconds. If `endISO` is before `startISO`, return `"PT0S"`.

**Formula:** `"PT" + max(0, (endMs - startMs) / 1000) + "S"`

**Example:** `iso8601Duration("2025-01-01T00:00:00Z", "2025-01-01T01:00:00Z")` → `"PT3600S"`

### 9.2 Custom Builtins

Implementations must support registering custom builtin functions that augment or override the defaults. A custom builtin receives its arguments as already-evaluated values and returns a value.

---

## 10. Compilation

A conforming implementation may optionally provide a **compile** function that pre-processes an expression tree into an optimized callable form (e.g., a closure tree). The compiled form must produce results identical to the interpreter for all inputs.

Compilation walks the expression tree once at setup time and produces a function that, when called with a scope, returns the same result as `evaluate(expr, scope, builtins)`.

The compilation phase may capture builtin function references at compile time. Impure builtins (like `uuid` or `now`) must still produce fresh values on each invocation of the compiled expression.

---

## Appendix A: Operator Quick Reference

| Operator | Syntax | Result type |
|----------|--------|-------------|
| `select` | `[pathStep, ...]` | any |
| `eq` | `[left, right]` | boolean |
| `neq` | `[left, right]` | boolean |
| `gt` | `[left, right]` | boolean |
| `lt` | `[left, right]` | boolean |
| `gte` | `[left, right]` | boolean |
| `lte` | `[left, right]` | boolean |
| `and` | `[expr, ...]` | boolean |
| `or` | `[expr, ...]` | boolean |
| `not` | `expr` | boolean |
| `if` | `[cond, then, else]` | any |
| `cond` | `[[guard, value], ...]` | any \| undefined |
| `in` | `[value, array]` | boolean |
| `ref` | `"name"` | any |
| `param` | `"name"` | any |
| `let` | `[{bindings}, body]` | any |
| `coalesce` | `[expr, ...]` | any \| undefined |
| `isNull` | `expr` | boolean |
| `add` | `[left, right]` | number |
| `sub` | `[left, right]` | number |
| `mul` | `[left, right]` | number |
| `div` | `[left, right]` | number |
| `object` | `{key: expr, ...}` | object |
| `len` | `expr` | number |
| `at` | `[array, index]` | any \| undefined |
| `merge` | `[expr, ...]` | object |
| `concat` | `[expr, ...]` | array |
| `pick` | `[obj, keys]` | object |
| `prepend` | `[array, value]` | array |
| `multiSelect` | `[expr, ...]` | array |
| `filter` | `[arr, "name", pred]` or `["name", pred]` | array |
| `map` | `[arr, "name", body]` or `["name", body]` | array |
| `every` | `[arr, "name", pred]` or `["name", pred]` | boolean |
| `some` | `[arr, "name", pred]` or `["name", pred]` | boolean |
| `reduce` | see §5.2 | any |
| `mapVals` | `[obj, "name", body]` or `["name", body]` | object |
| `filterKeys` | `[obj, "name", pred]` or `["name", pred]` | object |
| `deepSelect` | `[source, "name", pred]` or `["name", pred]` | array |
| `pipe` | `[expr, ...]` | any \| undefined |
| `condPath` | `[input, [guard, result], ...]` | any \| undefined |
| `fn` | `["name", arg, ...]` | any |

## Appendix B: Grammar (Informal)

```
Expr       = Literal | OperatorObj | UnknownObj
Literal    = null | boolean | number | string | array
OperatorObj = { operatorKey: operands }
UnknownObj = { ... }  (no recognized operator key → passthrough)

Path       = [ rootStep, ...navSteps ]
rootStep   = string
navStep    = string | { param: string } | { ref: string } | { where: Expr } | Expr

Transform  = { path: Path, set?: Expr, append?: Expr, remove?: true }

ActionDef  = AssignAction | EmitAction | RaiseAction | EnqueueAction
AssignAction   = { type: "assign", let?: {name: Expr}, transforms: [Transform] }
EmitAction     = { type: "emit", event: {key: Expr} }
RaiseAction    = { type: "raise", event: {key: Expr}, delay?: Expr, id?: string }
EnqueueAction  = { type: "enqueueActions", let?: {name: Expr}, actions: [(ActionDef | GuardedBlock)] }
GuardedBlock   = { guard: Expr, actions: [ActionDef] }

ActionResult   = { type: "assign", context: object }
               | { type: "emit", event: object }
               | { type: "raise", event: object, delay?: number, id?: string }
```
