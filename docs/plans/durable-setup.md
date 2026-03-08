# `durableSetup()` — Runtime Event & Input Schemas for Dashboard Forms

## Context

The dashboard currently renders raw JSON textareas for event payloads and
instance input. XState v5's `types` parameter provides TypeScript type
inference but is erased at runtime — the dashboard has no way to know what
fields an event expects. We need a lightweight way to declare event/input
schemas that:

1. Survive to runtime (stored on `machine.schemas`)
2. Drive TypeScript inference (no loss of type expressivity)
3. Integrate naturally with XState's `setup()` API
4. Enable the dashboard to render typed form fields (text, number, select, etc.)

## Design

`durableSetup()` wraps XState's `setup()`. The user writes string-literal
schema notation instead of TypeScript phantom types:

```typescript
const machine = durableSetup({
  events: {
    PAY: { cardToken: "string", amount: "number" },
    UPDATE_STATUS: { status: ["draft", "review", "published"] },
    CANCEL: {},               // no payload
  },
  input: { orderId: "string", total: "number" },
  actors: { /* pass through to setup() */ },
  actions: { /* pass through */ },
  guards: { /* pass through */ },
  delays: { /* pass through */ },
}).createMachine({ /* standard XState config */ });
```

Schema notation (field value → TS type → form input):
- `"string"` → `string` → text input
- `"number"` → `number` → number input
- `"boolean"` → `boolean` → checkbox
- `"date"` → `string` → date input
- `"string?"`, `"number?"` etc. → optional field
- `["a", "b", "c"]` → `"a" | "b" | "c"` → select dropdown

## Implementation

### Phase 1: Schema types + `durableSetup()` in `durable-machine`

**File: `packages/durable-machine/src/schema.ts`** (new)

```typescript
// Schema notation types
export type FieldSchema =
  | "string" | "number" | "boolean" | "date"
  | "string?" | "number?" | "boolean?" | "date?"
  | readonly string[];  // enum: ["a", "b", "c"]

export type EventSchemaMap = Record<string, Record<string, FieldSchema>>;
export type InputSchema = Record<string, FieldSchema>;

// Type resolution: schema notation → TypeScript types
type Resolve<T extends FieldSchema> =
  T extends "string" ? string :
  T extends "number" ? number :
  T extends "boolean" ? boolean :
  T extends "date" ? string :
  T extends "string?" ? string | undefined :
  T extends "number?" ? number | undefined :
  T extends "boolean?" ? boolean | undefined :
  T extends "date?" ? string | undefined :
  T extends readonly string[] ? T[number] :
  never;

// Resolve an object of field schemas to a typed object
type ResolveFields<T extends Record<string, FieldSchema>> = {
  // Required fields (non-optional)
  [K in keyof T as T[K] extends `${string}?` ? never : K]: Resolve<T[K]>;
} & {
  // Optional fields
  [K in keyof T as T[K] extends `${string}?` ? K : never]?: Resolve<T[K]>;
};

// Resolve event schema map → XState event union
type ResolveEvents<T extends EventSchemaMap> = {
  [K in keyof T]: { type: K } & ResolveFields<T[K]>;
}[keyof T];
```

**`durableSetup()` function:**
- Accepts `events?`, `input?`, plus all standard `setup()` pass-through params (`actors`, `actions`, `guards`, `delays`)
- Converts `events`/`input` schema objects into `FormField[]` arrays (runtime data)
- Stores them via `schemas: { "xstate-durable": { events: {...}, input: {...} } }`
- Passes through to XState's `setup()` with correct phantom `types` wiring
- Returns the same `SetupReturn` shape (`.createMachine()`, etc.)

**`schemaToFormFields()` helper:**
- Converts `Record<string, FieldSchema>` → `FormField[]`
- `"string"` → `{ name, label, type: "text", required: true }`
- `"number"` → `{ name, label, type: "number", required: true }`
- `"boolean"` → `{ name, label, type: "checkbox", required: false }`
- `"date"` → `{ name, label, type: "date", required: true }`
- `"string?"` etc. → same but `required: false`
- `["a","b"]` → `{ name, label, type: "select", options: ["a","b"], required: true }`

### Phase 2: `FormField` + `SerializedMachine` extensions

**File: `packages/durable-machine/src/types.ts`** (modify)

- Add `"checkbox"` to `FormField.type` union: `"text" | "number" | "select" | "date" | "checkbox"`
- Add to `SerializedMachine`:
  ```typescript
  eventSchemas?: Record<string, FormField[]>;  // keyed by event type
  inputSchema?: FormField[];
  ```

**File: `packages/durable-machine/src/visualization.ts`** (modify)

- In `serializeMachineDefinition()`, after building the states map, read
  `machine.schemas?.["xstate-durable"]` and copy `events`/`input` into the
  `SerializedMachine` result as `eventSchemas`/`inputSchema`

### Phase 3: Gateway schema support

**File: `packages/gateway/src/hateoas.ts`** (modify)

- Add `getAvailableEventSchemas(machine, snapshot)`:
  Returns `Record<string, FormField[]>` for events available in the current
  state. Reads `machine.schemas?.["xstate-durable"]?.events`, filters to only
  events returned by `getAvailableEvents()`.

**File: `packages/gateway/src/dashboard/routes.ts`** (modify)

- Import `getAvailableEventSchemas` from `hateoas.ts`
- In `buildDetailData()`, call `getAvailableEventSchemas()` and include in return
- In SSE `sendUpdate()`, include `eventSchemas` in the state data payload
- In `instanceListPage` route, compute `inputSchema` from `serializeMachineDefinition()` and pass to template

**File: `packages/gateway/src/dashboard/html.ts`** (modify)

- Add `eventSchemas?: Record<string, FormField[]>` and `inputSchema?: FormField[]` to `InstanceDetailData`
- Embed `eventSchemas` in `runtime-data` JSON
- **Event sender form**: When a schema exists for the selected event, render
  typed form fields instead of JSON textarea. If no schema, fall back to textarea.
  Use a `<div id="event-fields">` container that client JS populates on select change.
- **Start form**: When `inputSchema` exists, render typed fields instead of
  JSON textarea. Server-rendered (not dynamic).

### Phase 4: Client-side dynamic event form

**File: `packages/gateway/src/dashboard/client.ts`** (modify)

- On event type `<select>` change: look up `eventSchemas[selectedType]`
- If schema exists: replace `<textarea>` with typed `<input>` elements
  (text, number, date, checkbox, select). Collect values into JSON on submit.
- If no schema: show the JSON `<textarea>` (current behavior)
- On SSE `state` event: update `eventSchemas` and re-render if selected event changed

### Phase 5: Exports + tests

**File: `packages/durable-machine/src/index.ts`** (modify)
- Export `durableSetup`, `schemaToFormFields`, schema types

**File: `packages/durable-machine/tests/unit/schema.test.ts`** (new)
- `durableSetup()` returns a setup result with `.createMachine()`
- `machine.schemas` contains the expected schema data
- `schemaToFormFields()` converts notation correctly
- `serializeMachineDefinition()` includes `eventSchemas`/`inputSchema`
- Type-level tests: verify inference works (compile-only assertions)

**File: `packages/gateway/tests/unit/dashboard/hateoas.test.ts`** (new or extend existing)
- `getAvailableEventSchemas()` returns schemas only for available events

## Files to modify

| File | Action |
|------|--------|
| `packages/durable-machine/src/schema.ts` | **Create** — `durableSetup()`, schema types, `schemaToFormFields()` |
| `packages/durable-machine/src/types.ts` | **Modify** — add `"checkbox"` to `FormField.type`, add `eventSchemas`/`inputSchema` to `SerializedMachine` |
| `packages/durable-machine/src/visualization.ts` | **Modify** — read `machine.schemas` in `serializeMachineDefinition()` |
| `packages/durable-machine/src/index.ts` | **Modify** — export new symbols |
| `packages/gateway/src/hateoas.ts` | **Modify** — add `getAvailableEventSchemas()` |
| `packages/gateway/src/dashboard/routes.ts` | **Modify** — pass schemas to templates and SSE |
| `packages/gateway/src/dashboard/html.ts` | **Modify** — typed form rendering |
| `packages/gateway/src/dashboard/client.ts` | **Modify** — dynamic event form fields |
| `packages/durable-machine/tests/unit/schema.test.ts` | **Create** — unit tests |

## Key reuse

- `FormField` type from `types.ts` (line 83) — extend with `"checkbox"`
- `SerializedMachine` from `types.ts` (line 296) — extend with schema fields
- `serializeMachineDefinition()` from `visualization.ts` (line 22) — add schema extraction
- `getAvailableEvents()` from `hateoas.ts` — filter schemas to available events
- `META_KEY = "xstate-durable"` convention for `machine.schemas` key
- XState's `setup({ schemas })` — runtime storage, `schemas?: unknown`

## Implementation Status

All phases implemented. Typecheck clean, all tests passing
(353 durable-machine, 238 gateway).

## Verification

```bash
# Type check
pnpm --filter @durable-xstate/durable-machine typecheck
pnpm --filter gateway typecheck

# Unit tests
pnpm --filter @durable-xstate/durable-machine test
pnpm --filter gateway test

# Manual: create a machine with durableSetup(), register with gateway,
# open dashboard, verify:
# - Event sender shows typed fields when event selected
# - Start form shows typed fields when inputSchema present
# - Fallback to JSON textarea when no schema
```
