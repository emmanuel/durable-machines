# @durable-xstate/expr

A JSON expression evaluator for serializable XState v5 machine logic. Expressions are plain JSON objects — no code strings, no `eval`, fully serializable and database-storable.

## Why

XState v5 machines use JavaScript functions for guards, actions, and assignments. That works great in code, but breaks when you need to store machine definitions in a database or send them over the wire. This package replaces those functions with a JSON expression language that can be evaluated at runtime or pre-compiled to closures.

## Install

```bash
pnpm add @durable-xstate/expr
```

## Quick Start

```typescript
import { evaluate, compile, createScope, defaultBuiltins } from "@durable-xstate/expr";

const scope = createScope({
  context: { count: 5, items: ["a", "b", "c"] },
  event: { type: "INCREMENT", amount: 3 },
});

// Interpret mode — evaluate directly
evaluate({ add: [{ select: ["context", "count"] }, { select: ["event", "amount"] }] }, scope);
// => 8

// Compiled mode — faster for repeated evaluation
const expr = compile({ len: { select: ["context", "items"] } });
expr(scope);
// => 3
```

## Two Evaluation Modes

**Interpret** (`evaluate`) walks the expression tree at runtime. Simple, no setup cost.

**Compile** (`compile`) walks the tree once and returns a closure. Higher setup cost, but subsequent calls are faster. Both produce identical results.

## Scope

Every expression evaluates against a `Scope`:

| Field | Description |
|-------|-------------|
| `context` | The machine's persistent state data |
| `event` | The current event payload |
| `params` | Static parameters (machine config, query params) |
| `bindings` | Named values from `let`, iteration, and `pipe` |

## Expression Language

See [EXPR_SPEC.md](./EXPR_SPEC.md) for the complete language specification.

### Highlights

**Path navigation** with dynamic keys and collection filtering:
```json
{ "select": ["context", "sessions", { "param": "sessionId" }, "state"] }
```

**Collection pipelines** with transducer composition:
```json
{ "pipe": [
  { "select": ["context", "todos"] },
  { "filter": ["t", { "not": { "select": ["t", "completed"] } }] },
  { "map": ["t", { "select": ["t", "title"] }] },
  { "len": { "ref": "$" } }
]}
```

**Guards** that are just boolean expressions:
```json
{ "and": [
  { "lt": [{ "select": ["context", "attempts"] }, 3] },
  { "eq": [{ "select": ["event", "type"] }, "SUBMIT"] }
]}
```

**Actions** as declarative transforms:
```typescript
import { evaluateActions, createScope } from "@durable-xstate/expr";

const action = {
  type: "assign" as const,
  transforms: [
    { path: ["context", "count"], set: { add: [{ select: ["context", "count"] }, 1] } },
    { path: ["context", "lastEvent"], set: { select: ["event", "type"] } },
  ],
};

const results = evaluateActions([action], createScope({ context: { count: 0 } }));
// => [{ type: "assign", context: { count: 1, lastEvent: undefined } }]
```

## Builtins

Register custom functions callable via `{ "fn": ["name", arg1, arg2] }`:

```typescript
import { createBuiltinRegistry } from "@durable-xstate/expr";

const builtins = createBuiltinRegistry({
  clamp: (val, min, max) => Math.max(min as number, Math.min(max as number, val as number)),
});
```

Default builtins: `uuid`, `now`, `iso8601Duration`.

## API

| Export | Description |
|--------|-------------|
| `evaluate(expr, scope, builtins?)` | Interpret an expression |
| `compile(expr, builtins?)` | Compile to a closure |
| `evaluateActions(actions, scope, builtins?)` | Evaluate action definitions |
| `compileGuard(expr, builtins?)` | Compile a boolean guard |
| `compileAction(action, builtins?)` | Compile an action definition |
| `selectPath(path, scope, builtins?)` | Navigate a path |
| `applyTransforms(context, transforms, scope, builtins?)` | Apply transforms to context |
| `createScope(partial)` | Create a scope with defaults |
| `createBuiltinRegistry(custom)` | Merge custom builtins with defaults |
| `defaultBuiltins` | The default builtin registry |

## License

MIT
