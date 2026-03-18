# Plan: Cloudflare Durable Objects Backend

## Status: Deferred

No concrete user demand. Revisit if edge deployment or zero-infrastructure use cases
create pull. Analysis preserved below for future reference.

## Problem

The PG backend requires a PostgreSQL database and a long-running Node.js process.
The DBOS backend requires the DBOS runtime. Both are server-side. There's no option for:

1. **Edge deployment** — machines running at CF's 300+ global PoPs, sub-50ms latency
2. **Zero-infrastructure** — no database to provision, no servers to manage
3. **Single-writer semantics** — Durable Objects guarantee exactly one instance processes
   events at a time, eliminating the need for row-level locking and retry loops

Cloudflare Durable Objects are a natural fit: each DO instance *is* a state machine
instance — isolated, single-threaded, with built-in persistence and alarm scheduling.

## Core Insight

The pure XState utilities in `@durable-machines/machine` (`initialTransition`,
`transition`, `isDurableState`, `getActiveInvocation`, `getSortedAfterDelays`,
`resolveTransientTransitions`, etc.) are runtime-agnostic. The event processor algorithm
is the same everywhere — only the storage and concurrency model differ.

A DO backend reuses these pure functions and replaces:

| PG backend component | DO equivalent |
|---------------------|---------------|
| `pg/store.ts` (Postgres tables) | `do-store.ts` (DO embedded SQLite) |
| Row-level `FOR NO KEY UPDATE` locking | Single-writer guarantee (no locking needed) |
| `LISTEN/NOTIFY` + message queue | Direct RPC call to DO instance |
| Timeout poller (interval-based) | `ctx.storage.setAlarm()` (exact scheduling) |
| `pg/event-processor.ts` | `event-processor.ts` (same algorithm, simpler) |
| `pg/create-durable-machine.ts` | `create-durable-machine.ts` (DO namespace factory) |

## Separate Package

```
packages/cloudflare/
  src/
    types.ts
    do-store.ts
    event-processor.ts
    durable-object.ts
    stub-handle.ts
    create-durable-machine.ts
    index.ts
  tests/
    ...
  package.json
  tsconfig.json
  wrangler.jsonc (example/test config)
```

**Why a separate package?** CF Workers use a different runtime (workerd, not Node.js),
different types (`DurableObjectState`, not `Pool`), different test runner
(`@cloudflare/vitest-pool-workers`), and different build tooling (wrangler). Mixing
CF-specific code into the Node-based `durable-machine` package would force CF runtime
dependencies on all users.

The package imports from `@durable-machines/machine` for:
- `durableState`, `prompt`, `validateMachineForDurability`, `walkStateNodes`
- `isDurableState`, `getActiveInvocation`, `getSortedAfterDelays`, `buildAfterEvent`,
  `resolveTransientTransitions`, `extractActorImplementations`
- `serializeMachineDefinition`, `computeStateDurations`
- All shared types (`DurableMachine`, `DurableMachineHandle`, etc.)

## DOStore — SQLite Storage

Each DO gets its own embedded SQLite database (up to 10 GB on paid plans). SQLite is
the recommended storage backend for new CF projects — it's synchronous (no event loop
yield, no input gate concerns), supports transactions, and handles relational data
naturally.

```ts
// do-store.ts
export interface DOStore {
  /** Read the instance state */
  getInstance(): InstanceData | null;

  /** Write the instance state */
  putInstance(data: InstanceData): void;

  /** Read a cached invoke result */
  getInvokeResult(stepKey: string): { output: unknown; error: unknown } | null;

  /** Write a cached invoke result */
  recordInvokeResult(stepKey: string, output: unknown, error: unknown): void;

  /** Enqueue an event message */
  enqueueMessage(event: AnyEventObject): void;

  /** Consume the next unconsumed message (FIFO) */
  consumeNextMessage(): AnyEventObject | null;

  /** Append a transition record */
  appendTransition(from: StateValue | null, to: StateValue, event: string | null, ts: number): void;

  /** Read all transitions */
  getTransitions(): TransitionRecord[];

  /** Read all invoke results as StepInfo[] */
  listInvokeResults(): StepInfo[];
}

export function createDOStore(sql: SqlStorage): DOStore;
```

Note: All methods are **synchronous** — SQLite operations in DOs are synchronous and
don't yield the event loop. This simplifies the event processor significantly compared
to the async PG store.

### Schema (run in constructor via `blockConcurrencyWhile`)

```sql
CREATE TABLE IF NOT EXISTS instance (
  id          INTEGER PRIMARY KEY CHECK (id = 1),  -- single row
  state_value TEXT NOT NULL,      -- JSON
  context     TEXT NOT NULL,      -- JSON
  status      TEXT NOT NULL DEFAULT 'running',
  fired_delays TEXT NOT NULL DEFAULT '[]',  -- JSON array
  wake_at     INTEGER,
  input       TEXT                -- JSON
);

CREATE TABLE IF NOT EXISTS invoke_results (
  step_key     TEXT PRIMARY KEY,
  output       TEXT,   -- JSON
  error        TEXT,   -- JSON
  started_at   INTEGER,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  payload  TEXT NOT NULL,  -- JSON
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transition_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_state TEXT,  -- JSON
  to_state   TEXT NOT NULL,  -- JSON
  event      TEXT,
  ts         INTEGER NOT NULL
);
```

SQLite stores JSON as TEXT and values are serialized/deserialized via `JSON.parse` /
`JSON.stringify`. The single-row `instance` table matches the PG backend's one-row-per-
instance pattern, scoped naturally by the DO itself (each DO is one machine instance).

No locking is needed — a DO instance processes one request at a time (single-writer).
Multi-statement updates use `BEGIN`/`COMMIT` for atomicity:

```ts
sql.exec("BEGIN");
sql.exec("UPDATE instance SET state_value = ?, context = ?, status = ? WHERE id = 1",
  JSON.stringify(data.stateValue), JSON.stringify(data.context), data.status);
sql.exec("INSERT INTO invoke_results (step_key, output, error, started_at, completed_at) VALUES (?, ?, ?, ?, ?)",
  stepKey, JSON.stringify(output), JSON.stringify(error), startedAt, completedAt);
sql.exec("COMMIT");
```

## Event Processor

Same algorithm as `pg/event-processor.ts`, simplified by the single-writer guarantee:

```ts
// event-processor.ts
export interface DOEventProcessorOptions {
  store: DOStore;
  machine: AnyStateMachine;
  options: DurableMachineOptions;
  ctx: DurableObjectState;  // for setAlarm()
}

export function processStartup(
  deps: DOEventProcessorOptions,
  input: Record<string, unknown>,
): void;

export async function processEvent(
  deps: DOEventProcessorOptions,
  event: AnyEventObject,
): Promise<void>;

export async function processTimeout(
  deps: DOEventProcessorOptions,
): Promise<void>;
```

Key differences from PG event processor:

1. **No transaction wrapping for locking** — single-writer means no concurrent modifications.
   SQLite `BEGIN`/`COMMIT` used only for multi-statement atomicity.
2. **No row locking** — `lockAndGetInstance` becomes `store.getInstance()` (synchronous)
3. **No retry loop** — no `55P03` (lock not available) errors possible
4. **`setAlarm()` for after delays** — instead of a polling interval, the DO sets an
   alarm at the exact wake time: `await ctx.storage.setAlarm(wakeAt)`
5. **Direct RPC call processing** — no `LISTEN/NOTIFY`; the DO processes events
   immediately in the RPC method handler
6. **Synchronous storage reads** — `store.getInstance()` returns directly, no `await`
7. **Invoke actors are still async** — `executeInvocationsInline` remains async since
   actor implementations (`fromPromise`) are inherently asynchronous

## Durable Object Class

The generated DO class extends `DurableObject<Env>` (the CF base class) and uses
**RPC methods** (preferred over `fetch()` routing since `compatibility_date >= 2024-04-03`):

```ts
// durable-object.ts
import { DurableObject } from "cloudflare:workers";

export function createDurableObjectClass(
  machine: AnyStateMachine,
  options?: DurableMachineOptions,
) {
  return class DurableStateMachine extends DurableObject<Env> {
    private store: DOStore;
    private deps: DOEventProcessorOptions;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);

      // Run schema migrations before any requests
      ctx.blockConcurrencyWhile(async () => {
        ctx.storage.sql.exec(SCHEMA_SQL);
      });

      this.store = createDOStore(ctx.storage.sql);
      this.deps = { store: this.store, machine, options: options ?? {}, ctx };
    }

    // ── RPC Methods (called directly from stubs with full type safety) ───

    /** Start a new machine instance with the given input */
    async start(input: Record<string, unknown>): Promise<DurableStateSnapshot> {
      processStartup(this.deps, input);
      return this.readSnapshot();
    }

    /** Send an event to the machine */
    async send(event: AnyEventObject): Promise<DurableStateSnapshot> {
      await processEvent(this.deps, event);
      return this.readSnapshot();
    }

    /** Read current state */
    getState(): DurableStateSnapshot | null {
      const instance = this.store.getInstance();
      if (!instance) return null;
      return { value: instance.stateValue, context: instance.context, status: instance.status };
    }

    /** Read final result (context when done) */
    getResult(): { done: true; context: Record<string, unknown> } | { done: false } {
      const instance = this.store.getInstance();
      if (!instance) throw new Error("Instance not found");
      if (instance.status === "done") return { done: true, context: instance.context };
      return { done: false };
    }

    /** List durable steps executed so far */
    getSteps(): StepInfo[] {
      return this.store.listInvokeResults();
    }

    /** Cancel the machine instance */
    cancel(): void {
      this.store.putInstance({
        ...this.store.getInstance()!,
        status: "cancelled",
      });
    }

    // ── Alarm Handler ────────────────────────────────────────────────────

    async alarm(): Promise<void> {
      await processTimeout(this.deps);

      // If more delays remain, set next alarm
      const instance = this.store.getInstance();
      if (instance?.wakeAt) {
        await this.ctx.storage.setAlarm(instance.wakeAt);
      }
    }

    // ── Internal ─────────────────────────────────────────────────────────

    private readSnapshot(): DurableStateSnapshot {
      const instance = this.store.getInstance()!;
      return { value: instance.stateValue, context: instance.context, status: instance.status };
    }
  };
}
```

### Key DO patterns used

- **`extends DurableObject<Env>`** with `super(ctx, env)` — required base class
- **`blockConcurrencyWhile()`** in constructor — runs schema migrations before any
  requests are processed. This is the standard CF pattern for DO initialization.
- **RPC methods** — public methods on the class are callable directly from stubs with
  full TypeScript type safety. Preferred over `fetch()` routing since
  `compatibility_date >= 2024-04-03`.
- **`alarm()`** — reserved handler method, fires when `setAlarm()` time is reached.
  Fires even if the DO is hibernating. Retried automatically on failure (up to 6
  attempts with backoff). Only one alarm per DO — setting a new one replaces the old.
- **Synchronous reads** — `getState()`, `getResult()`, `getSteps()` are synchronous
  because SQLite operations don't yield the event loop
- **DOs don't know their own name/ID** — the instance ID is implicit in the DO's
  identity (one DO per machine instance). The factory passes the workflowId via the
  `start()` RPC call input.

### Usage in worker script

```ts
// worker.ts
import { DurableStateMachine } from "@durable-machines/cloudflare";
import { createDurableObjectClass } from "@durable-machines/cloudflare";
import { orderMachine } from "./machines.js";

export interface Env {
  ORDER_MACHINE: DurableObjectNamespace<InstanceType<ReturnType<typeof createDurableObjectClass>>>;
}

// Export the DO class — Cloudflare runtime discovers it by class_name
export const OrderMachine = createDurableObjectClass(orderMachine);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const instanceId = url.searchParams.get("id") ?? "default";

    // Get stub by name (deterministic — same name always routes to same DO)
    const stub = env.ORDER_MACHINE.getByName(`order:${instanceId}`);

    // Call RPC methods directly on the stub (type-safe)
    if (url.pathname === "/start") {
      const input = await request.json();
      const state = await stub.start(input);
      return Response.json(state, { status: 201 });
    }

    if (url.pathname === "/send") {
      const event = await request.json();
      const state = await stub.send(event);
      return Response.json(state);
    }

    if (url.pathname === "/state") {
      const state = await stub.getState();
      return state ? Response.json(state) : new Response("Not found", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  },
};
```

### Wrangler configuration

```jsonc
// wrangler.jsonc
{
  "name": "my-durable-machines",
  "main": "src/worker.ts",
  "compatibility_date": "2024-12-01",
  "durable_objects": {
    "bindings": [
      { "name": "ORDER_MACHINE", "class_name": "OrderMachine" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["OrderMachine"] }
  ]
}
```

## Stub Handle

`DurableMachineHandle` implementation that calls the DO's RPC methods directly
via the stub:

```ts
// stub-handle.ts
export function createStubHandle(
  stub: DurableObjectStub<DurableStateMachine>,
  workflowId: string,
): DurableMachineHandle;
```

Each method maps to an RPC call on the stub:

| Handle method | RPC call |
|--------------|----------|
| `send(event)` | `await stub.send(event)` |
| `getState()` | `await stub.getState()` |
| `getResult()` | Poll `stub.getResult()` until `done: true` |
| `getSteps()` | `await stub.getSteps()` |
| `cancel()` | `await stub.cancel()` |

RPC calls have full TypeScript type safety — the stub type matches the DO class.
Arguments and return values are serialized via the structured clone algorithm
(supports objects, arrays, Maps, Sets, Dates, etc.).

Creating a stub does NOT wake the DO — it's only activated when an RPC method is called.

## Factory

```ts
// create-durable-machine.ts
export interface CfDurableMachineOptions extends DurableMachineOptions {
  namespace: DurableObjectNamespace;
}

export function createDurableMachine<T extends AnyStateMachine>(
  machine: T,
  options: CfDurableMachineOptions,
): DurableMachine<T>;
```

The factory:

1. Validates the machine via `validateMachineForDurability()`
2. Returns a `DurableMachine` where:
   - `start(workflowId, input)` → gets stub via `namespace.getByName(`${machine.id}:${workflowId}`)`,
     calls `stub.start(input)`, returns stub handle
   - `get(workflowId)` → gets stub via `getByName()`, returns stub handle (no RPC — lazy)
   - `list(filter?)` → returns `[]` (see limitation below)

### Instance naming

DO instances are identified by `namespace.getByName(`${machine.id}:${workflowId}`)`.
`getByName()` is shorthand for `idFromName()` + `get()` — deterministic naming means
the same `workflowId` always routes to the same DO instance.

## `list()` Limitation

Durable Objects have no native "list all instances" API. The `list()` method returns
an empty array. Future options:

- **Registry DO**: A dedicated DO that tracks all instance IDs for a machine
- **D1 index**: A D1 table updated on start/complete, queried by `list()`
- **Analytics Engine**: Log events to AE, query for active instances

This is noted as a known limitation, not a blocker.

## Hibernation Considerations

DOs hibernate when idle — they are evicted from memory but can be woken instantly by
new requests. Key implications for the state machine DO:

- **In-memory state is lost on hibernation.** The constructor re-runs when the DO wakes.
  This is fine because all state is in SQLite — the `DOStore` reads from SQLite on every
  access, no in-memory caching needed.
- **Alarms fire even if the DO is hibernating** — they wake it up. This means `after`
  delays work correctly even if the DO has been idle.
- **`blockConcurrencyWhile()` re-runs in constructor** on every wake. Schema migrations
  use `CREATE TABLE IF NOT EXISTS` so this is idempotent.
- **WebSocket support** (future): If we add real-time state change notifications via
  WebSocket, use the Hibernatable WebSocket API (`ctx.acceptWebSocket()`, not
  `ws.accept()`) to allow the DO to sleep with connections open.

## Conformance Tests

The existing conformance test suites (`lifecycle`, `after-transitions`, `prompt-channels`,
`visualization`) are backend-agnostic — they depend only on `BackendFixture`. A CF
`BackendFixture` wires them up for the DO backend.

### Test infrastructure

Uses `@cloudflare/vitest-pool-workers` with miniflare for local DO simulation:

```ts
// vitest.config.ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
```

```ts
// tests/fixture.ts
import { env } from "cloudflare:test";
import type { BackendFixture } from "@durable-machines/machine/test-helpers";

export function createCfFixture(): BackendFixture {
  return {
    name: "cloudflare-do",

    async setup() {
      // miniflare handles DO lifecycle automatically
    },

    async teardown() {
      // miniflare cleanup is automatic
    },

    createMachine(machine, options) {
      return createDurableMachine(machine, {
        ...options,
        namespace: env.ORDER_MACHINE,  // miniflare binding from wrangler.jsonc
      });
    },
  };
}
```

### Alarm testing

`@cloudflare/vitest-pool-workers` provides `runDurableObjectAlarm` for testing alarms:

```ts
import { runDurableObjectAlarm } from "cloudflare:test";

it("fires after delay via alarm", async () => {
  const stub = env.ORDER_MACHINE.getByName("test-alarm");
  await stub.start({ orderId: "a1", total: 50 });

  // Trigger alarm manually (simulates time passing)
  const id = env.ORDER_MACHINE.idFromName("test-alarm");
  const alarmRan = await runDurableObjectAlarm(id);
  expect(alarmRan).toBe(true);

  const state = await stub.getState();
  expect(state!.value).toBe("timeout_state");
});
```

### Test harness export

`@durable-machines/machine` exports conformance test suites and fixtures via
new subpath exports:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./pg": "./src/pg/index.ts",
    "./dbos": "./src/dbos/index.ts",
    "./test-helpers": "./tests/fixtures/helpers.ts",
    "./test-conformance": "./tests/conformance/index.ts"
  }
}
```

This lets `@durable-machines/cloudflare` import `BackendFixture`, `waitForState`,
`lifecycleConformance`, etc. without duplicating test code.

### Conformance suites

All 4 existing suites:

1. `lifecycleConformance` — start, send, transitions, final state, cancel, list
2. `afterTransitionsConformance` — delay scheduling, reentry, accumulated delays
3. `promptChannelsConformance` — prompt entry/exit, channel adapter lifecycle
4. `visualizationConformance` — serialized definition, transition log, state durations

Plus CF-specific tests:
- Alarm-based `after` delays (verifying `setAlarm()` is called with correct timestamp,
  using `runDurableObjectAlarm()` to trigger)
- Hibernation recovery (DO evicted and re-created, state restored from SQLite)

## New Package Files

| File | Purpose |
|------|---------|
| `src/types.ts` | CF-specific types (`CfDurableMachineOptions`, `InstanceData`, `Env`) |
| `src/do-store.ts` | SQLite storage abstraction over `ctx.storage.sql` |
| `src/event-processor.ts` | Transition processing (reuses core pure functions) |
| `src/durable-object.ts` | `createDurableObjectClass()` — generates DO class extending `DurableObject<Env>` |
| `src/stub-handle.ts` | `DurableMachineHandle` via RPC calls on DO stub |
| `src/create-durable-machine.ts` | `createDurableMachine()` factory |
| `src/index.ts` | Re-exports |
| `wrangler.jsonc` | Example/test wrangler config with `new_sqlite_classes` migration |
| `tests/fixture.ts` | CF `BackendFixture` using miniflare + `cloudflare:test` |
| `tests/conformance.test.ts` | Runs all conformance suites with CF fixture |
| `tests/alarm.test.ts` | CF-specific `setAlarm()` / `runDurableObjectAlarm()` tests |

## Modified Files in `@durable-machines/machine`

| File | Changes |
|------|---------|
| `package.json` | Add `./test-helpers` and `./test-conformance` subpath exports |
| `tests/conformance/index.ts` | New file — barrel export for all conformance suites |

## Implementation Order

### Phase 1: DOStore + Event Processor

1. `src/types.ts` — CF-specific types
2. `src/do-store.ts` — SQLite storage abstraction with tests (synchronous API)
3. `src/event-processor.ts` — transition processing, adapted from PG event processor
   (synchronous storage reads, async invoke execution)

### Phase 2: DO Class + Stub + Factory

4. `src/durable-object.ts` — `createDurableObjectClass()` extending `DurableObject<Env>`,
   RPC methods, `blockConcurrencyWhile()` schema migration, alarm handler
5. `src/stub-handle.ts` — `DurableMachineHandle` via RPC (not fetch)
6. `src/create-durable-machine.ts` — factory using `namespace.getByName()`

### Phase 3: Conformance Tests

7. Add subpath exports to `@durable-machines/machine` for test helpers
8. `wrangler.jsonc` with `new_sqlite_classes` migration
9. `vitest.config.ts` with `@cloudflare/vitest-pool-workers`
10. `tests/fixture.ts` — CF `BackendFixture` using `cloudflare:test` env bindings
11. Run all 4 conformance suites against CF backend
12. CF-specific alarm and hibernation tests

### Phase 4: Example Worker

13. `examples/order-worker/` — minimal CF Worker demonstrating a durable order machine
    with RPC methods, alarm-based delays, deployed via `wrangler dev`

## CF-Specific Gotchas

1. **One alarm per DO.** Setting a new alarm replaces the existing one. For `after`
   delays, we track all unfired delays in `fired_delays` and set a single alarm for
   the soonest one — same pattern as the PG backend's `wake_at` column.
2. **SQLite ops are synchronous.** `sql.exec()` does not yield the event loop. This
   means no input gate concerns and no interleaving during storage access.
3. **In-memory state is lost on hibernation.** The constructor re-runs when the DO wakes.
   Don't cache state in instance fields unless backed by SQLite.
4. **DOs don't know their own name/ID.** If the DO needs its identity (e.g. for logging),
   the `start()` RPC call should store the workflowId in the instance table.
5. **`deleteAll()` is the only way to fully clean up storage.** Used by the `cancel()`
   method if we want to reclaim storage (optional — we can also just mark status).
6. **`blockConcurrencyWhile()` blocks ALL requests.** Used only in constructor for
   schema migrations. Regular RPC methods don't need it (SQLite is synchronous).
7. **RPC serialization uses structured clone.** Supports objects, arrays, Maps, Sets,
   Dates, ArrayBuffers, Errors — but NOT functions or class instances with prototypes.
   Our `DurableStateSnapshot` (plain objects with `StateValue` + context) serializes fine.
