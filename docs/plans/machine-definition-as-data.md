# Plan: Machine Definition as Data

## Status: Planned

Prerequisite: none (works with existing `createDurableMachine()`). Enhanced by first-class
effects plan (effect declarations in JSON definitions). Does not require any backend changes
— the output is a standard `AnyStateMachine`.

## Problem

Today, every durable state machine must be defined in TypeScript using XState's
`createMachine()` API. This works well for compile-time machines, but prevents:

1. **API-driven machine creation** — a SaaS platform that lets tenants define workflows
   via a REST API, stored in a database
2. **Dynamic machines from data** — machines generated from business rules, config files,
   or LLM output at runtime
3. **Cross-language portability** — machines defined as JSON that can be created by any
   language and executed by the Node.js runtime

The gap: we need a way to separate machine *structure* (states, transitions, guards —
data) from machine *behavior* (actor implementations, action functions — code), then
combine them at runtime.

## Core Insight

XState v5's `setup()` API already supports named implementations: guards, actions,
actors, and delays are referenced by string name in the machine config and provided
as implementations at setup time. We formalize this into two pieces:

1. **Implementation registry** — a frozen, immutable collection of named
   implementations, created once at app startup
2. **JSON machine definition** — a serializable data structure describing the state
   graph, referencing implementations by name

`createMachineFromDefinition(definition, registry)` combines them into a standard
`AnyStateMachine` that works with the existing `createDurableMachine()` pipeline.

## Implementation Registry

```ts
// definition/registry.ts
export interface ImplementationRegistry {
  readonly id: string;
  readonly actors: ReadonlyMap<string, AnyActorLogic>;
  readonly guards: ReadonlyMap<string, GuardFunction>;
  readonly actions: ReadonlyMap<string, ActionFunction>;
  readonly delays: ReadonlyMap<string, DelayFunction | number>;
  readonly effectHandlers?: ReadonlyMap<string, EffectHandler>;
}

export function createImplementationRegistry(config: {
  id: string;
  actors?: Record<string, AnyActorLogic>;
  guards?: Record<string, GuardFunction>;
  actions?: Record<string, ActionFunction>;
  delays?: Record<string, DelayFunction | number>;
  effectHandlers?: Record<string, EffectHandler>;
}): ImplementationRegistry;
```

The registry is:

- **Per-app, not per-machine**: One registry serves all dynamically-created machines.
  Machines reference a subset of the available implementations.
- **Frozen/immutable**: `Object.freeze` on creation. Cannot be mutated after app startup.
- **String-keyed**: Every implementation has a unique name. Machines reference these names.
- **Has an `id`**: Used for binding validation — a definition can declare which registry
  it requires.

## JSON Definition Format

```ts
// definition/types.ts
export interface MachineDefinition {
  /** Machine identifier — becomes the XState machine id */
  id: string;

  /** Initial state key */
  initial: string;

  /** Static context — merged with input at creation time */
  context?: Record<string, unknown>;

  /** State tree */
  states: Record<string, StateDefinition>;

  /** Optional: required registry id for binding validation */
  registryId?: string;
}

export interface StateDefinition {
  type?: "atomic" | "compound" | "parallel" | "final" | "history";
  initial?: string;
  states?: Record<string, StateDefinition>;

  /** Durable marker — equivalent to spreading durableState() */
  durable?: boolean;

  /** Prompt config — equivalent to spreading prompt() */
  prompt?: PromptConfig;

  /** Effects — equivalent to effects option on durableState()/prompt() */
  effects?: EffectConfig[];

  /** Event handlers */
  on?: Record<string, TransitionDefinition | TransitionDefinition[]>;

  /** Eventless transitions */
  always?: TransitionDefinition | TransitionDefinition[];

  /** Delayed transitions */
  after?: Record<string, TransitionDefinition | TransitionDefinition[]>;

  /** Invocations — reference actors by name */
  invoke?: InvokeDefinition | InvokeDefinition[];
}

export interface TransitionDefinition {
  target?: string;
  guard?: string | { type: string; params?: Record<string, unknown> };
  actions?: string | string[] | ActionDefinition[];
}

export interface ActionDefinition {
  type: string;
  params?: Record<string, unknown>;
}

export interface InvokeDefinition {
  src: string;
  id?: string;
  input?: Record<string, unknown> | { "$ref": string };
  onDone?: TransitionDefinition | string;
  onError?: TransitionDefinition | string;
}
```

### Key constraints

- **Static context only**: No factory functions in JSON. Context is a plain object
  merged with `input` at creation time.
- **Named implementations only**: No inline function bodies. All guards, actions, and
  actors are referenced by name.
- **`AnyStateMachine` return type**: The created machine loses compile-time type safety
  (context shape, event types) in exchange for runtime flexibility.

## Expression System

Two expression forms for referencing runtime values in JSON definitions:

### `$ref` — Value extraction

Used in invoke `input` and action `params` to reference context/event values:

```json
{
  "invoke": {
    "src": "chargeCard",
    "input": {
      "total": { "$ref": "context.total" },
      "orderId": { "$ref": "context.orderId" }
    }
  }
}
```

A `$ref` value is resolved at runtime to the referenced value, preserving its type.

### `{{ template }}` — String interpolation

Used in prompts, effects, and string values:

```json
{
  "prompt": {
    "type": "confirm",
    "text": "Ship order {{ context.orderId }}?",
    "confirmEvent": "SHIP",
    "cancelEvent": "CANCEL"
  }
}
```

### Implementation

```ts
// definition/expressions.ts

/** Resolve a $ref expression to a runtime value */
export function resolveRef(
  ref: string,
  scope: { context: Record<string, unknown>; event?: AnyEventObject; input?: Record<string, unknown> },
): unknown;

/** Check if a value is a $ref expression */
export function isRef(value: unknown): value is { "$ref": string };

/** Recursively resolve all $ref and {{ template }} expressions in an object */
export function resolveExpressions(
  value: unknown,
  scope: { context: Record<string, unknown>; event?: AnyEventObject; input?: Record<string, unknown> },
): unknown;
```

Dot-paths only for v1 — no complex expressions, filters, or conditionals. Scope
prefixes: `context.*`, `event.*`, `input.*`.

## Config Transformation

```ts
// definition/transform.ts

export function transformDefinition(
  definition: MachineDefinition,
  registry: ImplementationRegistry,
): XStateMachineConfig;
```

Transforms the JSON definition into an XState-compatible config object:

| JSON definition | XState config |
|----------------|---------------|
| `context: { orderId: "default" }` | `context: ({ input }) => ({ orderId: "default", ...input })` — factory that merges static defaults with runtime input |
| `invoke.input: { "$ref": "context.total" }` | `input: ({ context }) => resolveExpressions(invoke.input, { context })` — mapper function |
| `prompt: { text: "{{ context.name }}" }` | `meta["xstate-durable"].prompt` with text as resolver function |
| `durable: true` | `meta["xstate-durable"].durable: true` |
| `effects: [...]` | `meta["xstate-durable"].effects: [...]` |
| `guard: { type: "isAbove", params: { threshold: 100 } }` | Pass through directly — XState v5 resolves named guards with params natively |
| `actions: "notifyUser"` | Pass through directly — XState v5 resolves named actions natively |

## Machine Creation

```ts
// definition/create-machine.ts
import { setup, createMachine } from "xstate";

export function createMachineFromDefinition(
  definition: MachineDefinition,
  registry: ImplementationRegistry,
): AnyStateMachine {
  // 1. Validate definition against registry
  const validation = validateDefinition(definition, registry);
  if (!validation.valid) {
    throw new DurableMachineValidationError(validation.errors);
  }

  // 2. Transform JSON definition to XState config
  const config = transformDefinition(definition, registry);

  // 3. Setup with registry implementations
  const machineSetup = setup({
    actors: Object.fromEntries(registry.actors),
    guards: Object.fromEntries(registry.guards),
    actions: Object.fromEntries(registry.actions),
    delays: Object.fromEntries(registry.delays),
  });

  // 4. Create machine
  return machineSetup.createMachine(config);
}
```

The returned `AnyStateMachine` is fully compatible with `createDurableMachine()` from
both the PG and DBOS backends. No backend changes are needed.

## Runtime Validation

```ts
// definition/validate-definition.ts

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateDefinition(
  definition: MachineDefinition,
  registry: ImplementationRegistry,
): ValidationResult;
```

Returns `{ valid, errors, warnings }` instead of throwing — suitable for API responses
where the caller needs structured error information.

### Checks

1. **Referenced implementations exist**: Every actor `src`, guard `type`, action `type`,
   delay name referenced in the definition must exist in the registry
2. **State structure valid**: Initial states exist, targets resolve, no orphan states
3. **Durability classification correct**: Same rules as `validateMachineForDurability()` —
   every non-final atomic state must be durable, invoking, or transient
4. **Expression syntax valid**: `$ref` paths parse correctly, `{{ }}` pairs are balanced
5. **Registry binding**: If `definition.registryId` is set, it must match `registry.id`
6. **Effect types valid**: If effects are declared, their types must match registry
   effect handlers or built-ins

### Relationship to `validateMachineForDurability()`

`validateDefinition()` runs *before* machine creation — it validates the JSON structure
against the registry. `validateMachineForDurability()` runs on the created
`AnyStateMachine` inside `createDurableMachine()` as a second validation pass. Both must
pass for a machine to become durable.

## Definition Storage (Future)

Optional `machine_definitions` table for the PG backend:

```sql
CREATE TABLE IF NOT EXISTS machine_definitions (
  name            TEXT PRIMARY KEY,
  definition      JSONB NOT NULL,
  registry_id     TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
```

This is deferred — definitions can be stored anywhere (filesystem, S3, another DB).
The table is a convenience for the runtime usage pattern.

## Runtime Usage Example

End-to-end example showing how all pieces fit together:

### 1. App startup

```ts
import { createImplementationRegistry } from "@durable-xstate/durable-machine/definition";
import { createDurableMachine } from "@durable-xstate/durable-machine/pg";
import { Pool } from "pg";
import { Hono } from "hono";

// One registry for the whole app
const registry = createImplementationRegistry({
  id: "acme-v1",
  actors: {
    chargeCard: fromPromise(async ({ input }) => { /* ... */ }),
    sendShipment: fromPromise(async ({ input }) => { /* ... */ }),
    refundPayment: fromPromise(async ({ input }) => { /* ... */ }),
  },
  guards: {
    isAboveThreshold: ({ context }, params) => context.total > params.threshold,
    isExpressShipping: ({ context }) => context.shippingMethod === "express",
  },
  actions: {
    notifyUser: ({ context }, params) => { /* side effect */ },
  },
});

const pool = new Pool();
const app = new Hono();

// In-memory cache of created DurableMachines (keyed by definition name)
const machines = new Map<string, DurableMachine>();
```

### 2. `POST /definitions` — Submit a JSON machine definition

```ts
app.post("/definitions", async (c) => {
  const definition = await c.req.json<MachineDefinition>();

  // Validate against registry — returns structured errors, doesn't throw
  const result = validateDefinition(definition, registry);
  if (!result.valid) {
    return c.json({ valid: false, errors: result.errors, warnings: result.warnings }, 400);
  }

  // Store in DB (or filesystem, etc.)
  await pool.query(
    `INSERT INTO machine_definitions (name, definition, registry_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (name) DO UPDATE SET definition = $2, updated_at = $4`,
    [definition.id, JSON.stringify(definition), registry.id, Date.now()],
  );

  return c.json({ valid: true, warnings: result.warnings });
});
```

### 3. `POST /definitions/:name/instances` — Start an instance

```ts
app.post("/definitions/:name/instances", async (c) => {
  const name = c.req.param("name");
  const { instanceId, input } = await c.req.json();

  // Lazily create DurableMachine for this definition
  if (!machines.has(name)) {
    const { rows } = await pool.query(
      "SELECT definition FROM machine_definitions WHERE name = $1",
      [name],
    );
    if (rows.length === 0) return c.json({ error: "Definition not found" }, 404);

    const machine = createMachineFromDefinition(rows[0].definition, registry);
    const durable = createDurableMachine(machine, { pool });
    machines.set(name, durable);
  }

  const durable = machines.get(name)!;
  const handle = await durable.start(instanceId, input);
  const state = await handle.getState();

  return c.json({
    instanceId,
    state: state!.value,
    context: state!.context,
    links: {
      self: `/definitions/${name}/instances/${instanceId}`,
      send: `/definitions/${name}/instances/${instanceId}/events`,
      result: `/definitions/${name}/instances/${instanceId}/result`,
      steps: `/definitions/${name}/instances/${instanceId}/steps`,
      cancel: `/definitions/${name}/instances/${instanceId}`,
    },
  }, 201);
});
```

### 4. `POST /definitions/:name/instances/:id/events` — Send an event

```ts
app.post("/definitions/:name/instances/:id/events", async (c) => {
  const name = c.req.param("name");
  const id = c.req.param("id");
  const event = await c.req.json();  // { type: "PAY" }

  const durable = machines.get(name);
  if (!durable) return c.json({ error: "Machine not loaded" }, 404);

  const handle = durable.get(id);
  await handle.send(event);
  const state = await handle.getState();

  return c.json({
    instanceId: id,
    state: state!.value,
    context: state!.context,
    links: {
      self: `/definitions/${name}/instances/${id}`,
      send: `/definitions/${name}/instances/${id}/events`,
      result: `/definitions/${name}/instances/${id}/result`,
    },
  });
});
```

### 5. `GET /definitions/:name/instances/:id` — Read current state

```ts
app.get("/definitions/:name/instances/:id", async (c) => {
  const name = c.req.param("name");
  const id = c.req.param("id");

  const durable = machines.get(name);
  if (!durable) return c.json({ error: "Machine not loaded" }, 404);

  const state = await durable.get(id).getState();
  if (!state) return c.json({ error: "Instance not found" }, 404);

  return c.json({
    instanceId: id,
    state: state.value,
    context: state.context,
    status: state.status,
  });
});
```

This demonstrates: one app hosts multiple dynamically-defined machines sharing one
registry, with definitions arriving at runtime and instances created on demand.

## New Files

| File | Purpose |
|------|---------|
| `src/definition/types.ts` | `MachineDefinition`, `StateDefinition`, `TransitionDefinition`, etc. |
| `src/definition/registry.ts` | `createImplementationRegistry()` |
| `src/definition/expressions.ts` | `$ref` resolution, template resolution, `resolveExpressions()` |
| `src/definition/transform.ts` | `transformDefinition()` — JSON → XState config |
| `src/definition/create-machine.ts` | `createMachineFromDefinition()` |
| `src/definition/validate-definition.ts` | `validateDefinition()` → `{ valid, errors, warnings }` |
| `src/definition/index.ts` | Re-exports |

## Modified Files

| File | Changes |
|------|---------|
| `src/index.ts` | Re-export `definition/` module |

## Tests

### Unit tests

- `tests/unit/definition/expressions.test.ts` — `$ref` resolution, template resolution,
  nested objects, missing paths, edge cases
- `tests/unit/definition/registry.test.ts` — creation, immutability, missing id
- `tests/unit/definition/validate-definition.test.ts` — all validation checks, structured
  error output, warnings
- `tests/unit/definition/transform.test.ts` — each transformation rule, context factory,
  invoke input mappers, prompt resolvers
- `tests/unit/definition/create-machine.test.ts` — end-to-end: JSON definition → working
  XState machine

### Conformance tests

- `tests/conformance/definition.ts` — create machines from JSON definitions and verify
  identical behavior to equivalent TypeScript-defined machines:
  - Basic lifecycle (start, send events, reach final state)
  - Invoke actors resolve correctly
  - Guards with params work
  - Prompts resolve templates
  - Context merge with input

### Integration tests

- `tests/integration/pg/definition.test.ts` — JSON-defined machines running through the
  PG backend end-to-end
- `tests/integration/dbos/definition.test.ts` — same for DBOS backend

## Implementation Order

1. **Types + expressions**: `definition/types.ts` and `definition/expressions.ts` with tests
2. **Registry**: `definition/registry.ts` with tests
3. **Validation**: `definition/validate-definition.ts` with tests
4. **Transformation**: `definition/transform.ts` with tests
5. **Machine creation**: `definition/create-machine.ts` with end-to-end tests
6. **Integration**: Conformance + integration tests against both backends
7. **Storage (future)**: `machine_definitions` table — deferred to when needed

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Static context only | Functions can't be serialized to JSON. Static defaults merged with runtime input cover all practical cases. |
| Named implementations only | Inline code in JSON is a security risk and defeats the purpose of separating structure from behavior. |
| `AnyStateMachine` return type | Lose compile-time types, gain runtime flexibility. TypeScript-defined machines still get full type safety. |
| Registry is per-app | One registry serves all machines. Avoids duplication and ensures consistent behavior across dynamic definitions. |
| `validateDefinition()` returns vs throws | API callers need structured errors, not try/catch. `validateMachineForDurability()` still throws for the second pass. |
| `$ref` + `{{ template }}` expressions | Two complementary forms: `$ref` preserves types for values, templates interpolate strings. Covers all practical needs without a full expression language. |
