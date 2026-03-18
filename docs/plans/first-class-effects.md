# Plan: First-Class Effects

## Status: Done

Implemented in commits `3b4a6fc` (first-class effects system) and `6758db5` (transactional
outbox for durable effect execution).

## Problem

State machines often need to trigger fire-and-forget side effects after transitions:
send a webhook, emit an analytics event, enqueue a background job, notify an external
system. Today these must be implemented as invoke actors — which block the transition
and require done/error events — or crammed into `assign` actions that smuggle async
work into what should be pure transitions.

Neither approach is right. Side effects should be:

1. **Declared on states** — visible in the machine definition, validated at registration
2. **Executed after commit** — only fire when the state transition has been durably persisted
3. **Reliable** — retried on failure, dead-lettered after exhaustion
4. **Template-driven** — reference context/event values without writing code

## Core Insight

Effects are the third marker alongside `durableState()` and `prompt()`. They follow the
same `meta["xstate-durable"]` convention and are collected *after* each transition by a
pure function, then executed asynchronously by the backend.

## Effect Declaration

### State-level effects via marker

Effects are declared on state nodes using the existing marker pattern. Because XState v5
merges `meta` via shallow Object.assign, a separate `effects()` spread would clobber
`durableState()` or `prompt()` meta. Instead, effects are an optional parameter on the
existing markers:

```ts
import { durableState, prompt } from "@durable-machines/machine";

const machine = createMachine({
  id: "order",
  initial: "pending",
  states: {
    pending: {
      ...durableState({
        effects: [
          { type: "webhook", url: "https://example.com/hook", body: { orderId: "{{ context.orderId }}" } },
        ],
      }),
      on: { PAY: "processing" },
    },
    processing: {
      invoke: { src: "chargeCard", input: ({ context }) => ({ total: context.total }) },
      onDone: "paid",
    },
    paid: {
      ...prompt(
        { type: "confirm", text: "Ship order?", confirmEvent: "SHIP", cancelEvent: "CANCEL" },
        {
          effects: [
            { type: "webhook", url: "https://example.com/paid", body: { orderId: "{{ context.orderId }}" } },
            { type: "sendEmail", to: "{{ context.customerEmail }}", subject: "Order confirmed" },
          ],
        },
      ),
      on: { SHIP: "shipped", CANCEL: "cancelled" },
    },
    shipped: { type: "final" },
    cancelled: { type: "final" },
  },
});
```

### Meta clobbering solution

`durableState()` and `prompt()` accept an optional second/trailing options object
containing `effects`. The markers merge effects into the same
`meta["xstate-durable"]` object:

```ts
// durable-state.ts
export function durableState(options?: { effects?: EffectConfig[] }) {
  return {
    meta: {
      [META_KEY]: {
        durable: true,
        ...(options?.effects ? { effects: options.effects } : {}),
      },
    },
  } as const;
}

// prompt.ts
export function prompt(config: PromptConfig, options?: { effects?: EffectConfig[] }) {
  return {
    meta: {
      [META_KEY]: {
        durable: true,
        prompt: config,
        ...(options?.effects ? { effects: options.effects } : {}),
      },
    },
  } as const;
}
```

No separate `effects()` spread is needed — meta clobbering is avoided entirely.

### Context-accumulated effects

For effects that should fire conditionally or accumulate across transitions, the
`contextEffectsKey` option on `createDurableMachine()` names a context field (e.g.
`"pendingEffects"`) that the effect collector drains after each transition:

```ts
const durable = createDurableMachine(machine, {
  pool,
  contextEffectsKey: "pendingEffects",
});
```

Machine actions use `assign` to push effects into this array:

```ts
assign({
  pendingEffects: ({ context }) => [
    ...context.pendingEffects,
    { type: "webhook", url: "https://example.com/step-done" },
  ],
});
```

The collector drains `context[contextEffectsKey]` after each transition, resets it to
`[]`, and includes the drained effects in the outbox alongside state-level effects.

### Transition-level effects (deferred)

XState v5 drops unknown keys on transition definitions (`on: { PAY: { target: "...", effects: [...] } }`
silently loses the `effects` key). Context-accumulation via `assign` is the workaround.
Transition-level effects may be revisited if XState v5 adds extension points.

## Template Expressions

A `template.ts` module resolves `{{ dotPath }}` expressions in effect payloads.

### Resolution rules

| Pattern | Input | Output |
|---------|-------|--------|
| `"{{ context.orderId }}"` | Full-string template | Preserves original type (`string`, `number`, etc.) |
| `"Order {{ context.orderId }} shipped"` | Inline template | Always returns `string` |
| `"plain string"` | No templates | Pass-through |
| Non-string value | Object, array, number | Recursive descent into nested values |

### Dot-path resolution

Dot-paths support `context.*` and `event.*` scopes:

```ts
function resolveDotPath(
  path: string,
  scope: { context: Record<string, unknown>; event?: AnyEventObject },
): unknown;
```

Paths like `context.order.items[0].sku` use standard JS property access semantics.
Missing paths resolve to `undefined`.

### Implementation

```ts
// template.ts
export function resolveTemplateValue(
  value: unknown,
  scope: { context: Record<string, unknown>; event?: AnyEventObject },
): unknown;
```

Recursive: strings are scanned for `{{ ... }}`; objects/arrays recurse into values;
primitives pass through.

## Effect Handlers Registry

```ts
// effect-handlers.ts
export interface EffectHandler {
  (effect: ResolvedEffect): Promise<void>;
}

export interface EffectHandlerRegistry {
  readonly handlers: ReadonlyMap<string, EffectHandler>;
}

export function createEffectHandlers(
  handlers: Record<string, EffectHandler>,
): EffectHandlerRegistry;
```

### Built-in handlers

- **`webhook`**: `POST` to a URL with a JSON body. Configurable headers, timeout,
  retry policy. Uses `fetch()`.

Custom handlers are registered by name:

```ts
const handlers = createEffectHandlers({
  sendEmail: async (effect) => { /* ... */ },
  enqueueJob: async (effect) => { /* ... */ },
});
```

## Effect Collector

A pure function that runs after each transition to gather effects from both state
meta and context:

```ts
// effect-collector.ts
export interface ResolvedEffect {
  type: string;
  [key: string]: unknown;
}

export function collectAndResolveEffects(
  machine: AnyStateMachine,
  prevSnapshot: AnyMachineSnapshot,
  nextSnapshot: AnyMachineSnapshot,
  event: AnyEventObject,
  contextEffectsKey?: string,
): { effects: ResolvedEffect[]; cleanedContext?: Record<string, unknown> };
```

Steps:
1. Determine entered/exited state nodes by diffing `prevSnapshot._nodes` vs
   `nextSnapshot._nodes`
2. Collect `onEntry` effects from entered nodes' `meta["xstate-durable"].effects`
3. Collect `onExit` effects from exited nodes' `meta["xstate-durable"].effects`
   (if `trigger: "exit"` is specified — default is `"entry"`)
4. Drain `context[contextEffectsKey]` if configured
5. Resolve all template expressions against `{ context: nextSnapshot.context, event }`
6. Return resolved effects + optional cleaned context (with drained key reset to `[]`)

## Effect Types

```ts
// effects.ts (types + marker helpers)
export interface EffectConfig {
  /** Effect handler name — must match a registered handler or built-in */
  type: string;
  /** When to trigger: on state entry (default) or exit */
  trigger?: "entry" | "exit";
  /** Arbitrary payload — values may contain {{ template }} expressions */
  [key: string]: unknown;
}

export interface WebhookEffectConfig extends EffectConfig {
  type: "webhook";
  url: string;
  method?: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  body?: unknown;
}
```

## PG Backend Integration

### Schema addition: `effect_outbox` table

```sql
CREATE TABLE IF NOT EXISTS effect_outbox (
  id              BIGSERIAL PRIMARY KEY,
  instance_id     TEXT NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  effect_type     TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | dead
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 5,
  next_retry_at   BIGINT,
  created_at      BIGINT NOT NULL,
  completed_at    BIGINT
);
CREATE INDEX IF NOT EXISTS idx_eo_pending ON effect_outbox (status, next_retry_at)
  WHERE status IN ('pending', 'processing');
```

### Outbox insert (transactional)

In `pg/event-processor.ts`, after each transition commit, collected effects are
bulk-inserted into `effect_outbox` using `unnest` arrays within the same transaction:

```sql
INSERT INTO effect_outbox (instance_id, effect_type, payload, created_at)
SELECT $1, unnest($2::text[]), unnest($3::jsonb[]), $4;
```

This guarantees effects are committed atomically with the state transition.

### Effect executor

```ts
// pg/effect-executor.ts
export interface EffectExecutorOptions {
  pool: Pool;
  handlers: EffectHandlerRegistry;
  pollIntervalMs?: number;   // default: 1000
  batchSize?: number;         // default: 10
  maxAttempts?: number;        // default: 5
}

export function createEffectExecutor(options: EffectExecutorOptions): {
  start(): void;
  stop(): Promise<void>;
};
```

The executor polls `effect_outbox` for `pending` effects:

1. `SELECT ... FROM effect_outbox WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= $1) ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`
2. Set `status = 'processing'`
3. Execute handler, update to `done` on success
4. On failure: increment `attempts`, compute `next_retry_at` with exponential backoff
5. If `attempts >= max_attempts`: set `status = 'dead'`

The executor runs as a background poller started by `createDurableMachine()`, similar
to the existing timeout poller.

## DBOS Backend Integration

In the DBOS backend, each collected effect becomes a child workflow launched via
`DBOS.startWorkflow()`. Effect handler functions are pre-registered at
`createDurableMachine()` time as DBOS workflows, giving them automatic retry and
observability.

```ts
// In dbos/create-durable-machine.ts
const effectWorkflows = new Map<string, Function>();
for (const [type, handler] of handlers.entries()) {
  const wf = DBOS.registerWorkflow(
    async (effect: ResolvedEffect) => handler(effect),
    { name: `effect:${machine.id}:${type}` },
  );
  effectWorkflows.set(type, wf);
}
```

After each transition in the machine loop, collected effects are dispatched:

```ts
for (const effect of collectedEffects) {
  const wf = effectWorkflows.get(effect.type);
  if (wf) await DBOS.startWorkflow(wf)({ ...effect });
}
```

## Validation

`validateMachineForDurability()` gains additional checks:

1. Effect `type` must match a registered handler name or built-in (`"webhook"`)
2. Template syntax is valid (`{{ }}` pairs are balanced, dot-paths parse correctly)
3. Effects are only declared on states that are durable or have `invoke` (not on
   transient `always` states — they transition immediately, effects would be ambiguous)

Validation requires the handler registry to be passed in:

```ts
export function validateMachineForDurability(
  machine: AnyStateMachine,
  options?: { effectHandlers?: EffectHandlerRegistry },
): void;
```

The existing signature (no options) remains backward-compatible — effect validation
is skipped if no registry is provided.

## Serialization

`SerializedStateNode` gains an optional `effects` field:

```ts
export interface SerializedStateNode {
  // ... existing fields ...
  effects?: { type: string; trigger?: "entry" | "exit"; [key: string]: unknown }[];
}
```

`serializeMachineDefinition()` in `visualization.ts` extracts effects from
`meta["xstate-durable"].effects` and includes them in the serialized output.

## New Files

| File | Purpose |
|------|---------|
| `src/effects.ts` | `EffectConfig` types, type guards |
| `src/template.ts` | Template expression resolution (`{{ context.field }}`) |
| `src/effect-handlers.ts` | `createEffectHandlers()`, built-in `webhook` handler |
| `src/effect-collector.ts` | `collectAndResolveEffects()` pure function |
| `src/pg/effect-executor.ts` | Async outbox drainer with retry/dead-letter |

## Modified Files

| File | Changes |
|------|---------|
| `src/durable-state.ts` | `durableState()` accepts optional `{ effects }` |
| `src/prompt.ts` | `prompt()` accepts optional trailing `{ effects }` |
| `src/types.ts` | `SerializedStateNode.effects`, effect-related types |
| `src/validate.ts` | Effect type + template validation |
| `src/visualization.ts` | Extract effects into `SerializedStateNode` |
| `src/pg/store.ts` | `effect_outbox` table in schema, outbox insert/query methods |
| `src/pg/event-processor.ts` | Call `collectAndResolveEffects()`, bulk insert into outbox |
| `src/pg/create-durable-machine.ts` | Start/stop effect executor, accept handler registry |
| `src/dbos/machine-loop.ts` | Dispatch effect child workflows after transitions |
| `src/dbos/create-durable-machine.ts` | Register effect handler workflows |
| `src/index.ts` | Re-export new modules |

## Tests

### Unit tests

- `tests/unit/template.test.ts` — full-string templates, inline templates, dot-path
  resolution, nested objects, missing paths, non-string pass-through
- `tests/unit/effect-collector.test.ts` — onEntry/onExit collection, context drain,
  template resolution, empty cases
- `tests/unit/effect-handlers.test.ts` — registry creation, webhook handler (mocked fetch),
  unknown type errors
- `tests/unit/effects.test.ts` — type guards, marker integration with `durableState()`
  and `prompt()`

### Conformance tests

- `tests/conformance/effects.ts` — new conformance suite:
  - Effects fire after state entry
  - Effects fire only once (idempotent after crash recovery)
  - Context-accumulated effects drain correctly
  - Template expressions resolve against context and event
  - Failed effects retry and eventually dead-letter
- Fixture machines in `tests/fixtures/machines.ts` with effects declared

### Integration tests

- `tests/integration/pg/effects.test.ts` — PG-specific: outbox insert, executor
  polling, dead-letter
- `tests/integration/dbos/effects.test.ts` — DBOS-specific: child workflow dispatch

## Implementation Order

1. **Types + markers**: `effects.ts` types, update `durableState()` and `prompt()` signatures
2. **Templates**: `template.ts` with full test coverage
3. **Collection**: `effect-collector.ts` pure function + tests
4. **Handlers**: `effect-handlers.ts` registry + built-in webhook + tests
5. **Validation + serialization**: Update `validate.ts` and `visualization.ts`
6. **PG integration**: `effect_outbox` schema, outbox insert in event-processor,
   `effect-executor.ts` drainer
7. **DBOS integration**: Child workflow registration and dispatch in machine loop
8. **Conformance tests**: Effect conformance suite, fixture machines
9. **Exports**: Update `src/index.ts`
