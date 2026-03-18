# XState-Compatible Statecharts with Logic as Data

## Goal

An expression language and evaluator that makes **XState v5 machine logic (guards, assigns, effects) fully serializable as JSON data**. Machine definitions — including all behavioral logic — are stored, transmitted, and versioned as plain JSON. A lightweight evaluator executes them. No host-language functions required for standard operations.

The expression language is JSON-native, inspired by Clojure's Specter library for navigating and transforming nested data. It's designed to be trivially implementable in any runtime — JS first, Rust later.

## Motivation

### The serialization gap

XState v5 machines use JavaScript functions for guards, assigns, and actions. `machine.toJSON()` serializes the state topology and transition structure, but logic is reduced to named references (`{ type: "myGuard", params: {...} }`) that resolve against a host-code registry at runtime. This means:

- Machine definitions aren't fully portable — you need matching host code deployed alongside the config
- Machines can't be authored, stored, and executed purely as data
- Dynamic machine generation (e.g., generating state topology from a course structure) still requires host code for the behavioral logic

### What "logic as data" enables

Machine definitions where **everything is data**: the state topology, the transitions, the guards, the assigns, the effect declarations. Store a machine config as JSONB. Load it in any runtime with a conforming evaluator. No host-code registry needed for standard operations.

This unlocks:
- **Runtime-defined machines** — create and modify machine behavior via API, not deploys
- **Cross-runtime portability** — same machine config runs in JS, Rust, Wasm, or inside PostgreSQL
- **Inspectability** — guards and assigns are data you can query, diff, and validate, not opaque functions
- **Versioned behavior** — machine logic is data that can be migrated, rolled back, and audited

### Why JS first

- The existing durable-machines Node.js runtime is production-ready
- The expression evaluator is small (~200 lines of JS)
- Can validate the expression language design against real machines (the CMI5 registration machine) before committing to additional runtime implementations
- The XState v5 conformance tests run in JS

### Future runtimes

The expression language is designed for dual-runtime evaluation from day one — every operator is trivially implementable in both JS and Rust, with no language-specific features.

**Rust / PostgreSQL extension (long-term):** Moves the interpreter inside PostgreSQL, eliminating the external worker process entirely:

```
Today:    Event INSERT → NOTIFY → external worker → interpreter → write state
Future:   Event INSERT → PG trigger → Rust interpreter in-process → same transaction
```

**Wasm:** The same evaluator compiled to WebAssembly for browser or edge execution.

These are future goals. The JS evaluator validates the design first.

## Compatibility Contract

**Inputs:**
- `machine.toJSON()` — XState v5 serialized machine config (topology + named references)
- Extended machine config — topology + inline data expressions for guards/assigns
- `actor.getPersistedSnapshot()` — XState v5 serialized runtime state

**Outputs:**
- Persisted snapshots loadable by `createActor(machine, { snapshot })` in JS
- State values identical to what XState produces for the same machine + event sequence

**Verification:** Conformance test suite that runs event sequences through both XState (with host-code implementations) and the data-expression evaluator, asserting snapshot equality at every step.

## Statechart Semantics

Full SCXML algorithm as implemented by XState v5:
- Hierarchical (compound) states
- Parallel (orthogonal) regions
- History states (shallow and deep)
- Guards (boolean conditions on transitions)
- Actions (entry, exit, transition)
- Eventless (always) transitions
- Delayed transitions (after)
- Invoked services (child actors)

## XState v5 Built-in Primitives

The expression language must provide data-expression equivalents for every XState v5 built-in action and guard. XState v5 already separates definition from implementation via `setup()` / `.provide()` — named actions and guards (`{ type: 'name', params: {...} }`) are serializable. The gap is the built-in actions whose logic is closures.

### Built-in actions

| Action | XState type | Serializable? | Data expression equivalent |
|--------|-------------|---------------|---------------------------|
| `assign(fn)` | `xstate.assign` | No (closure) | Path-based transforms (see Expression Language) |
| `raise(event)` | `xstate.raise` | Partial (static events yes) | `{ "type": "raise", "event": <expr> }` |
| `emit(event)` | `xstate.emit` | Partial (static events yes) | `{ "type": "emit", "event": <expr> }` |
| `sendTo(target, event)` | `xstate.sendTo` | Partial (string target + static event) | `{ "type": "sendTo", "to": <expr>, "event": <expr> }` |
| `cancel(id)` | `xstate.cancel` | Partial (static ID yes) | `{ "type": "cancel", "sendId": <expr> }` |
| `spawnChild(src, opts)` | `xstate.spawnChild` | Partial (string src yes) | `{ "type": "spawnChild", "src": "name", "input": <expr> }` |
| `stopChild(id)` | `xstate.stopChild` | Partial (string ID yes) | `{ "type": "stopChild", "id": <expr> }` |
| `log(msg)` | `xstate.log` | Partial (static string yes) | `{ "type": "log", "value": <expr> }` |
| `enqueueActions(fn)` | `xstate.enqueueActions` | No (closure) | Conditional action blocks (see below) |

Where `<expr>` means a literal value or a data expression evaluated against the scope.

### `enqueueActions` — the critical pattern

`enqueueActions` is the **sole control-flow primitive** in XState v5 for actions. It replaced v4's `choose()` and `pure()`. It's a callback that can conditionally enqueue any combination of actions based on context, event, and guard evaluation:

```ts
enqueueActions(({ enqueue, check }) => {
  enqueue.assign({ ... });                          // always
  if (check('isValid')) {
    enqueue.assign({ ... });
    enqueue.emit({ type: 'VALIDATED' });
  }
  if (check({ type: 'isAboveThreshold', params: { min: 10 } })) {
    enqueue.raise({ type: 'ESCALATE' });
  }
  enqueue.emit({ type: 'PROCESSED' });              // always
});
```

This is the hardest built-in to serialize — its power comes from arbitrary JavaScript. The data expression equivalent mirrors v4's `choose()` format (an array of guard-action pairs) extended to support mixed entries — both plain actions and guarded blocks:

```json
{
  "type": "enqueueActions",
  "actions": [
    { "type": "assign", "transforms": ["..."] },
    {
      "guard": "isValid",
      "actions": [
        { "type": "assign", "transforms": ["..."] },
        { "type": "emit", "event": { "type": "VALIDATED" } }
      ]
    },
    {
      "guard": { "type": "isAboveThreshold", "params": { "min": 10 } },
      "actions": [
        { "type": "raise", "event": { "type": "ESCALATE" } }
      ]
    },
    { "type": "emit", "event": { "type": "PROCESSED" } }
  ]
}
```

Each entry in `actions` is either:
- **A plain action** (has `type`) — always executed, matching `enqueue(action)` without a guard
- **A guarded block** (has `guard` + `actions`) — conditionally executed, matching `if (check(guard)) { enqueue(actions) }`

**Evaluation semantics:** All entries are evaluated in order. Every guarded block's guard is checked independently — this is NOT first-match/`cond` semantics. Multiple blocks can fire for the same event. This directly mirrors how `enqueueActions` callbacks work: every `if (check(...))` is evaluated, not `if/else if`.

**Precedent:** XState v4's `choose()` action used the same shape — `[{ cond, actions }]` with all-blocks-evaluated semantics. The data expression format is a direct descendant.

Guards can be named references, parameterized guards, built-in combinators (`and`/`or`/`not`/`stateIn`), or inline data expressions.

**`let` bindings:** When `enqueueActions` needs intermediate values (e.g., capturing pre-transition state for conditional effects), `let` scopes across all entries:

```json
{
  "type": "enqueueActions",
  "let": {
    "wasPassed": { "select": ["context", "aus", { "param": "auId" }, "hasPassed"] }
  },
  "actions": [
    { "type": "assign", "transforms": ["...set hasPassed to true..."] },
    {
      "guard": { "and": [{ "ref": "next.hasPassed" }, { "not": { "ref": "wasPassed" } }] },
      "actions": [
        { "type": "emit", "event": { "type": "EMIT_AU_PASSED" } }
      ]
    }
  ]
}
```

`let` bindings are evaluated once before any entries execute — they capture values from the scope at that point. Assign actions within earlier entries do NOT retroactively change let-bound values (they're snapshots). This matches the common pattern of capturing pre-transition state, mutating context, then using the captured values to decide what to emit.

### Built-in guards

| Guard | XState form | Data expression equivalent |
|-------|-------------|---------------------------|
| Named | `"isValid"` | `"isValid"` (string reference, already serializable) |
| Parameterized | `{ type: "isGt", params: { min: 10 } }` | Same (already serializable) |
| `and([...])` | `and(["isValid", "isAuth"])` | `{ "type": "and", "guards": ["isValid", "isAuth"] }` |
| `or([...])` | `or(["isAdmin", "isOwner"])` | `{ "type": "or", "guards": ["isAdmin", "isOwner"] }` |
| `not(guard)` | `not("isDisabled")` | `{ "type": "not", "guard": "isDisabled" }` |
| `stateIn(value)` | `stateIn("#machine.active")` | `{ "type": "stateIn", "state": "#machine.active" }` |

Guard combinators compose arbitrarily:

```json
{ "type": "and", "guards": [
  "isValid",
  { "type": "or", "guards": [
    "isAdmin",
    { "type": "and", "guards": ["isOwner", { "type": "not", "guard": "isExpired" }] }
  ]}
]}
```

`stateIn` is particularly important for parallel states — it lets transitions in one region check the state of a sibling region.

### Delayed actions

`raise` and `sendTo` accept a `delay` option for scheduled events. `cancel` cancels a scheduled action by ID.

```json
{
  "type": "raise",
  "event": { "type": "SESSION_TIMEOUT" },
  "delay": 300000,
  "id": "session-timer"
}
```

```json
{ "type": "cancel", "sendId": "session-timer" }
```

For the durable runtime, delayed events become scheduled rows in the database (fire_at timestamp) rather than in-memory timers. The data expression format is the same — the runtime decides the implementation.

### Actor lifecycle

`invoke` (declared on state nodes), `spawnChild`, and `stopChild` manage child actors. In the data expression model:

- `invoke.src` references a named actor from the machine's `actors` section (already serializable)
- `invoke.input` can be a data expression
- `spawnChild` and `stopChild` use string IDs (already serializable)
- `invoke.onDone` and `invoke.onError` are standard transitions

For the durable runtime, invocations become effect records — the external executor manages the actual actor lifecycle.

## Expression Language

### Design principles

Inspired by Clojure's Specter library and Lisp's code-as-data philosophy:

1. **JSON-native** — Expressions are JSON values (objects, arrays, strings, numbers). No string-based DSL to parse. The expression IS the serialization format.
2. **Path-based navigation** — Inspired by Specter: paths are composable sequences of navigators that work for both reading (select) and writing (transform). A path is the fundamental primitive for data access and mutation.
3. **Immutable semantics** — Every operation returns a new value. Context is cloned at transition start, then transformed in place via the compiled path (JS and Rust both support mutable references on a clone).
4. **Small operator set** — ~25 operators covering access, logic, comparison, arithmetic, nullability, construction, collections, path transforms, and bindings.
5. **Dual-runtime evaluable** — Every operator must be trivially implementable in both JS and Rust. No operator leans on language-specific features.
6. **Registered builtins only for impure operations** — `uuid()`, `now()`. Domain-specific builtins like `iso8601Duration()` are registered explicitly per machine. All pure logic is expressed as data.

### Evaluation scope

Every expression evaluates against a scope containing:

- `context` — the machine's extended state (arbitrary JSON)
- `event` — the current event (`{ type, ...data }`)
- `params` — static data from the transition config (XState v5 native feature)

### Path navigators

Paths are arrays of navigators. A navigator is a step in traversing a data structure.

| Navigator | JSON form | Description |
|-----------|-----------|-------------|
| Key | `"fieldName"` | Navigate into map by static key |
| Dynamic key | `{"param": "auId"}` or `{"ref": "event.sessionId"}` | Navigate by runtime value |
| All | `{"all": true}` | Navigate to every element in a collection |
| Where | `{"where": {"eq": ["state", "active"]}}` | Navigate to elements matching a predicate |
| First/Last | `{"first": true}` / `{"last": true}` | First or last element |

Paths compose by concatenation: `["aus", {"param": "auId"}, "hasCompleted"]` is three navigators.

### Operations on paths

Transforms apply an operation at the location a path navigates to:

| Operation | JSON form | Description |
|-----------|-----------|-------------|
| Set | `{"set": <value>}` | Replace value at path |
| Append | `{"append": <value>}` | Add to end of array at path |
| Remove | `{"remove": true}` | Remove value at path |
| Apply | `{"apply": "add", "args": [1]}` | Apply arithmetic/builtin at path |

### Guard expressions

Guards are boolean expressions. Simple cases are just comparison objects:

```json
{"and": [
  {"eq": [{"select": ["event", "type"]}, "WAIVED"]},
  {"eq": [{"select": ["event", "auId"]}, {"param": "auId"}]}
]}
```

Complex guards use `let` for intermediate values and `cond` for multi-way branching:

```json
{
  "let": {
    "current": {"select": ["context", "aus", {"param": "auId"}]}
  },
  "body": {"cond": [
    [{"eq": [{"param": "moveOn"}, "Completed"]}, {"select": ["current", "hasCompleted"]}],
    [{"eq": [{"param": "moveOn"}, "Passed"]}, {"select": ["current", "hasPassed"]}],
    [{"eq": [{"param": "moveOn"}, "CompletedAndPassed"]},
     {"and": [{"select": ["current", "hasCompleted"]}, {"select": ["current", "hasPassed"]}]}],
    [{"eq": [{"param": "moveOn"}, "CompletedOrPassed"]},
     {"or": [{"select": ["current", "hasCompleted"]}, {"select": ["current", "hasPassed"]}]}],
    [true, false]
  ]}
}
```

### Assign actions (transforms)

Assigns are lists of path + operation pairs. The interpreter clones the context, applies each transform in order via mutable reference, and the result is the new context. Context is purely machine state — no effect bookkeeping.

```json
{
  "type": "assign",
  "let": {
    "sessionId": {"or": [{"select": ["event", "sessionId"]}, {"fn": "uuid"}]},
    "timestamp": {"or": [{"select": ["event", "timestamp"]}, {"fn": "now"}]}
  },
  "transforms": [
    {"path": ["aus", {"param": "auId"}, "hasCompleted"], "set": true},
    {"path": ["aus", {"param": "auId"}, "hasPassed"], "set": true},
    {"path": ["aus", {"param": "auId"}, "method"], "set": {"ref": "next.method"}},
    {"path": ["aus", {"param": "auId"}, "satisfiedAt"], "set": {"ref": "timestamp"}},
    {"path": ["lastSatisfyingSessionId"], "set": {"ref": "sessionId"}}
  ]
}
```

### Collection transforms via navigators

The `handleSessionLaunch` pattern — iterate sessions, filter for open ones, mark as abandoned — uses path navigators:

```json
{
  "type": "assign",
  "transforms": [
    {
      "path": ["sessions", {"where": {"in": ["state", ["launched", "active"]]}}, "state"],
      "set": "abandoned"
    },
    {
      "path": ["sessions", {"ref": "event.sessionId"}],
      "set": {
        "state": "launched",
        "auId": {"select": ["event", "auId"]},
        "launchedAt": {"select": ["event", "timestamp"]}
      }
    }
  ]
}
```

The `{"where": ...}` navigator selects matching elements. The `"state"` navigator descends into each. `"set": "abandoned"` applies. Non-matching elements are preserved automatically.

### Named expressions (DRY)

Guard and action logic can be defined once in the machine config and referenced by name with params — matching XState v5's native parameterized guard/action pattern:

```json
{
  "guards": {
    "verbSatisfiesAU": {
      "let": {"current": {"select": ["context", "aus", {"param": "auId"}]}},
      "body": {"and": [
        {"eq": [{"select": ["event", "auId"]}, {"param": "auId"}]},
        "...satisfaction check using params.moveOn..."
      ]}
    }
  },
  "states": {
    "pending": {
      "on": {
        "PASSED": {
          "guard": {"type": "verbSatisfiesAU", "params": {"auId": "au-1", "moveOn": "Completed", "masteryScore": 80, "verbId": "passed"}}
        }
      }
    }
  }
}
```

The `guards` section maps names to data expressions. `params` are XState v5's native mechanism for parameterizing reusable logic — the structure is compiled once, params are bound per-transition at event time.

### Effects via `emit()` — XState v5 native

Effects use XState v5's built-in `emit()` action — not context accumulation. `emit()` sends events to external subscribers, not to the machine itself. This is exactly the semantic of "declare a side effect for external execution."

**Why not context:** The previous approach (accumulating effects in a `pendingEffects` context array, then sending `CLEAR_EFFECTS` to drain it) conflates state with effect bookkeeping. Effects bloat context, persist in snapshots, and require a synthetic event to clear. `emit()` eliminates all of this — effects are actions that belong to the transition, not fields on the state.

**XState v5 action types and their roles:**

| Action | Behavior | Runtime handling |
|--------|----------|-----------------|
| `assign` | Context mutation | Executed inline, result persisted as new state |
| `raise` | Enqueue event for self | Executed inline (next microstep) |
| `emit` | Declare observable event | Captured by runtime → effects table |
| `sendTo` | Send event to another actor | Captured by runtime → effects table |

All four are XState v5 built-in, serializable actions.

**Conditional effects with `enqueueActions`:**

The registration machine conditionally emits effects based on what just changed (e.g., emit `EMIT_AU_PASSED` only when `hasPassed` flips from false to true). This requires comparing pre-transition and post-assign state. `enqueueActions` with `let` handles this idiomatically — `let` captures pre-transition values, assigns mutate context, and guarded blocks decide what to emit:

```json
{
  "type": "enqueueActions",
  "let": {
    "wasPassed": {"select": ["context", "aus", {"param": "auId"}, "hasPassed"]},
    "next": "...compute next satisfaction state...",
    "sessionId": {"or": [{"select": ["event", "sessionId"]}, {"fn": "uuid"}]},
    "timestamp": {"or": [{"select": ["event", "timestamp"]}, {"fn": "now"}]}
  },
  "actions": [
    {
      "type": "assign",
      "transforms": [
        {"path": ["aus", {"param": "auId"}, "hasPassed"], "set": {"ref": "next.hasPassed"}},
        {"path": ["aus", {"param": "auId"}, "hasCompleted"], "set": {"ref": "next.hasCompleted"}},
        {"path": ["aus", {"param": "auId"}, "method"], "set": {"ref": "next.method"}},
        {"path": ["aus", {"param": "auId"}, "satisfiedAt"], "set": {"ref": "next.satisfiedAt"}},
        {"path": ["lastSatisfyingSessionId"], "set": {"ref": "sessionId"}}
      ]
    },
    {
      "guard": {"and": [{"ref": "next.hasPassed"}, {"not": {"ref": "wasPassed"}}]},
      "actions": [{
        "type": "emit",
        "event": {
          "type": "EMIT_AU_PASSED",
          "auId": {"param": "auId"},
          "sessionId": {"ref": "sessionId"},
          "timestamp": {"ref": "timestamp"}
        }
      }]
    },
    {
      "type": "emit",
      "event": {
        "type": "EMIT_SATISFIED_AU",
        "registrationId": {"select": ["context", "registrationId"]},
        "auId": {"param": "auId"},
        "sessionId": {"ref": "sessionId"},
        "timestamp": {"ref": "timestamp"}
      }
    }
  ]
}
```

This is idiomatic XState v5: `enqueueActions` is the only place where conditional action logic lives. `let` captures pre-transition snapshots. Plain actions (assign, unconditional emit) execute always. Guarded blocks (conditional emit) execute only when their guard passes. All entries evaluated in order — the assign runs first, then the guarded emit checks against the let-bound pre-transition value, then the unconditional emit fires.

**Runtime integration (durable-machines):**

```ts
const actor = createActor(machine, { snapshot });
const emittedEffects: any[] = [];
actor.on('*', (event) => emittedEffects.push(event));
actor.start();
actor.send(event);
const newSnapshot = actor.getPersistedSnapshot();
actor.stop();

// Persist in same transaction
await store.saveSnapshot(instanceId, newSnapshot);
await store.insertEffects(instanceId, emittedEffects);
```

The runtime subscribes to all emitted events during the transition, captures them, and persists them alongside the new snapshot. No `pendingEffects` in context. No `clearEffects` hack. Effects belong to the transition, not the state.

### Operator reference

**Expression operators** (used inside guard expressions, assign values, and action params):

| Category | Operators |
|----------|-----------|
| Path access | `select` |
| Path transforms | `set`, `append`, `remove`, `apply` |
| Path navigators | key, `{"param"}`, `{"ref"}`, `{"all"}`, `{"where"}`, `{"first"}`, `{"last"}` |
| Logic | `and`, `or`, `not`, `if`, `cond` |
| Comparison | `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `in` |
| Arithmetic | `add`, `sub`, `mul`, `div` |
| Nullability | `coalesce`, `isNull` |
| Construction | `object` |
| Binding | `let` |
| Extension | `fn` (call registered builtin, with optional `args`) |

**Operators added after paper prototype validation:**

- `coalesce` — first non-null value (`??` in JS). Used pervasively for defaults: `{"coalesce": [{"select": ["event", "timestamp"]}, {"fn": "now"}]}`
- `isNull` — null/undefined check. Needed for optional fields like `event.score`: `{"isNull": {"ref": "score"}}`
- `object` — construct a literal object from computed values. Used for nested record construction: `{"object": {"scaled": {"ref": "score"}}}`
- `fn` with `args` — parameterized builtins (extends existing `fn` operator). Used for domain functions: `{"fn": "iso8601Duration", "args": [start, end]}`

**Action types** (XState v5 built-ins, all serializable in data expression form):

| Action | Purpose |
|--------|---------|
| `assign` | Context mutation via path transforms |
| `raise` | Enqueue event for self (with optional delay + id) |
| `emit` | Emit event to external observers |
| `sendTo` | Send event to another actor (with optional delay + id) |
| `cancel` | Cancel a delayed raise/sendTo by id |
| `spawnChild` | Spawn a child actor |
| `stopChild` | Stop a child actor |
| `log` | Log a value (development/debugging) |
| `enqueueActions` | Conditional action composition (guarded action blocks) |

**Guard types** (XState v5 built-ins):

| Guard | Purpose |
|-------|---------|
| String reference | Named guard from machine config |
| `{ type, params }` | Parameterized named guard |
| `{ type: "and", guards: [...] }` | Logical AND of guards |
| `{ type: "or", guards: [...] }` | Logical OR of guards |
| `{ type: "not", guard: ... }` | Logical NOT |
| `{ type: "stateIn", state: ... }` | Check current state (for parallel regions) |
| Inline data expression | Evaluated directly by the expression evaluator |

## Precompilation

### Structure vs parameters

Inspired by Specter's late-bound parameterization: the expression's **structure** is constant across all uses — only the `params` change per-transition. The evaluator separates these at load time:

1. Parse each named guard/action expression from the machine config
2. Identify param references — these are the "holes"
3. Compile the structure into a typed internal form with param slots
4. At event time: bind params from the transition config, evaluate

Every AU's `verbSatisfiesAU` guard reuses the same compiled structure. One compilation, N uses.

### Path compilation

A transform path `["aus", {"param": "auId"}, "hasCompleted"]` compiles into a direct access chain — not an interpreted navigator list walk. In JS:

```js
// Compiled form — direct property access
function apply(ctx, params, op) {
  op(ctx.aus[params.auId], "hasCompleted");
}
```

No navigator-type matching at runtime. No list iteration. Just property access.

### Transform batching

Multiple transforms sharing a path prefix:

```json
{"path": ["aus", {"param": "auId"}, "hasCompleted"], "set": true},
{"path": ["aus", {"param": "auId"}, "hasPassed"], "set": true},
{"path": ["aus", {"param": "auId"}, "method"], "set": "Completed"}
```

The precompiler merges these into one navigation to `context.aus[params.auId]`, then three field writes at that node. One traversal instead of three. The registration machine's `satisfyAU` action updates 5-6 fields on the same AU record — this optimization matters.

### Validation at load time

Precompilation catches errors when the machine config is stored/loaded, not when the 10,000th event hits a bad path:

- Path references unknown param names
- Guard uses unknown registered function
- Transform appends to a non-array path
- Circular let bindings
- Type mismatches in comparisons (when detectable statically)

### Caching

| Context | Cache strategy |
|---------|---------------|
| Node.js | Compiled form cached on the Machine object at construction time |
| Future: PG extension | Compiled form in backend-local memory, keyed by config hash |
| Future: Wasm | Same as Rust — compiled at instantiation |

## Implementation Plan

### Phase 1: Expression evaluator (JS)

Build the JSON expression evaluator as a standalone npm package. No XState dependency — it's a pure function: `evaluate(expr, scope) → value`.

- Recursive evaluator (~200 lines)
- Path navigator implementation (select + transform)
- `let` binding support
- Registered builtin functions (`uuid`, `now`, `duration`)
- Precompilation (JSON → compiled form, param slot identification)
- Transform batching optimization
- Comprehensive test suite with fixtures (JSON in, expected output)

### Phase 2: XState integration

Integrate the evaluator with XState v5's `setup()` / `createMachine()` pattern:

- Parse machine config JSON with inline data expressions
- Resolve named guards/actions to compiled expressions from the config's `guards`/`actions` sections
- Bind params per-transition
- Drop-in replacement: machine configs with data expressions produce identical snapshots to equivalent host-code implementations
- Conformance test: registration machine as data vs current host-code version

### Phase 3: durable-machines integration

Wire the data-expression evaluator into the existing event processor:

- Machine configs stored as JSONB in `machine_definitions` table
- Event processor loads config, precompiles, caches
- Guards and assigns evaluate via the expression evaluator
- Effects collected and written to effects table
- Existing gateway, REST API, persistence layer unchanged

### Phase 4: Rust evaluator (future)

Port the expression evaluator to Rust:

- Same JSON expression format, same semantics
- Conformance tests: same fixtures, assert identical output in both runtimes
- `serde_json::Value` as the value type
- Integrate with pgrx for PG extension

### Phase 5: PG extension (future)

Wrap the Rust evaluator as a PostgreSQL extension:

- `statechart.transition(config, state, event) → (new_state, effects[])`
- Trigger on `event_log` INSERT
- Precompiled configs cached in backend memory
- RLS-aware — runs within the same transaction/role context

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Expression format | JSON objects/arrays (not string DSL) | No parser needed; the expression IS the serialization; inspectable and transformable |
| Path model | Specter-inspired navigators | Unifies read (select) and write (transform); composable; handles nested/dynamic/filtered access |
| Context mutation | Clone + mutate in place | Both JS and Rust support mutable references; avoids Specter's reconstruct-on-return |
| Params | XState v5 native `params` | Already part of the serialization format; natural fit for late-bound parameterization |
| Named expressions | Defined in machine config `guards`/`actions` sections | Self-contained configs; no external registry for pure logic |
| Registered builtins | Only for impure/platform-specific ops | `uuid()`, `now()`, `duration()`; everything else is data |
| First runtime | JavaScript/Node.js | Validates design against real machines before Rust commitment |
| Precompilation | Separate structure from params at load time | Specter's key performance technique; one compilation per expression, N uses |

## Key Uncertainties

- **~~Completeness:~~** ✅ Resolved — paper prototype (`docs/plans/paper-prototype-registration-machine.md`) proves the full CMI5 registration machine (4 guards, 15 actions) is expressible as data expressions. All actions work with existing primitives + 4 new operators (`coalesce`, `isNull`, `object`, `fn` with `args`). `handleSessionLaunch` uses batch emit with the existing `where` navigator — no iteration primitive needed.
- **Language design iteration:** We're designing a programming language (~25 operators). Edge cases, composability issues, and error handling will emerge during real use, not during planning. Ship the smallest operator set first; add operators only when a real machine needs them.
- **Developer experience:** JSON expressions are ~5x more verbose than equivalent JS. Acceptable if machines are generated programmatically (like the registration machine from course structure). If humans write expressions directly, a syntactic sugar layer may be essential.
- **XState integration mechanism:** Phase 2 needs to clarify: generate JS closures from data expressions for `setup()`, or replace XState's interpreter, or extend via plugin. Each has different implications.
- **Performance:** Data expression evaluation vs native JS function calls is unmeasured. Precompilation to JS functions (not interpretation) is the escape hatch if overhead matters.

## Resolved Decisions

- **Effects model:** Use XState v5's native `emit()` action, not context accumulation. Effects are transition actions captured by the runtime, not fields on state. Eliminates `pendingEffects` context array and `CLEAR_EFFECTS` hack.
- **Expression format:** JSON-native (not string DSL). No parser; the expression is the serialization.
- **Params:** Carry forward XState v5's native `params` mechanism. Natural fit for late-bound parameterization.
- **`enqueueActions` serialization:** Array of mixed entries — plain actions (always) and guarded blocks (`{ guard, actions }`, conditional). All-blocks-evaluated semantics (not first-match), directly mirroring v4 `choose()` and v5 `enqueueActions` callback behavior. `let` bindings on `enqueueActions` scope across all entries for pre-transition value capture. No per-action guards outside `enqueueActions` — conditional actions always go through `enqueueActions`, matching idiomatic XState v5.
- **Paper prototype validation:** Full CMI5 registration machine (4 guards, 15 actions) validated as data expressions (`docs/plans/paper-prototype-registration-machine.md`). Required adding 4 operators (`coalesce`, `isNull`, `object`, `fn` with `args`) and 1 domain builtin (`iso8601Duration`). The decomposed `computeNextFlags` / `meetsMoveOnCriteria` / `satisfactionMethodFor` functions map cleanly to `let` binding patterns. No gaps remain.
- **Batch emit for collection effects:** `handleSessionLaunch` per-session abandon uses batch emit — one event with the filtered collection, effect processor fans out. The `where` navigator (already needed for the assign) is reused in a `select`/`entries` position for the emit payload. Zero new primitives.

## Open Questions

- **Naming:** What to call the expression evaluator package. `@durable-machines/expr`? `statechart-expr`?
- **Schema drift:** Machine config v1 produces state, then config v2 is deployed. Migration/compatibility story TBD.
- **`where` navigator semantics:** When a `where` navigator matches zero elements, should `set` create the element or no-op?
- **~~`let` scoping across actions:~~** ✅ Resolved: `let` on `enqueueActions` scopes across all entries. For transitions with multiple independent actions (not needing shared let bindings), use a plain action list. For transitions needing pre-transition capture + conditional logic, wrap in `enqueueActions` with `let`.
- **Trigger vs explicit call (PG, future):** Automatic processing on INSERT vs explicit invocation.
- **~~Iteration-with-effects (`handleSessionLaunch`):~~** ✅ Resolved — batch emit with `where` navigator. The `where` navigator already exists for the assign; reusing it in a `select`/`entries` position for the emit payload collects the filtered sessions. Effect processor fans out in plain TypeScript. Zero new primitives.
- **Shared computation fragments (`computations` section):** The `computeNextFlags` pattern (3 let bindings) is duplicated across 5 guards/actions. With the decomposed functions this is tolerable (~10 lines each). A `computations` section for shared expression fragments would DRY this up — nice-to-have, not blocking.

## Prior Art

| Project | Relevance |
|---------|-----------|
| [XState v5](https://github.com/statelyai/xstate) | The compatibility target. Source code = de facto spec. |
| [Specter](https://github.com/redplanetlabs/specter) | Clojure library for navigating/transforming nested data. Path model, precompilation, late-bound parameterization. |
| [JSONLogic](https://jsonlogic.com/) | Standard for representing logic as JSON. Simpler than what we need but validates the JSON-as-expressions approach. |
| [pgrx](https://github.com/pgcentralfoundation/pgrx) | Rust framework for PG extensions (future). |
| [cmars/statechart](https://github.com/cmars/statechart) | Rust SCXML interpreter, abandoned 2017. |
| [statig](https://github.com/mdeloof/statig) | Rust HSM library (compile-time/macro-based). |
| [SCXML spec](https://www.w3.org/TR/scxml/) | W3C standard. XState follows it closely. |
| [pgmq](https://github.com/tembo-io/pgmq) | Rust PG extension — reference for pgrx patterns (future). |
