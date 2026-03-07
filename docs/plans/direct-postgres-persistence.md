# Plan: Direct Postgres Persistence (Replace DBOS Runtime)

## Status: Done

Not blocked. This is a performance and architectural improvement to pursue when
the current DBOS-based approach hits scaling limits (many parked machines, slow
cold-start recovery, or desire for tighter DB integration).

## Problem

The current architecture uses DBOS Transact as the durability runtime. Every
active machine instance is a DBOS workflow — an async function suspended at
`await DBOS.recv()`. This has three costs:

1. **Memory per parked machine.** Each suspended workflow keeps its full closure
   alive: the XState snapshot (~2-5KB), transition history, Promise, setTimeout
   handle, DBOS notification callback. At 10K machines: 20-100MB. At 100K:
   untenable.

2. **Cold-start recovery.** On process restart, DBOS replays every PENDING
   workflow from step 0. Each replay does N database queries (one per cached
   step) to fast-forward to the `recv()` point. For 10K machines averaging 5
   steps each, that's 50K queries at startup before the process is ready.

3. **Abstraction tax.** We use 13 of DBOS's APIs. Under the hood, these map to
   ~6 SQL query patterns against 4 Postgres tables. The DBOS runtime adds
   ~4000 lines of code (SystemDatabase + executor), plus framework features we
   don't use: HTTP server, decorators, telemetry, scheduler, queues, auth,
   conductor integration, application versioning, workflow forking.

## Core Insight

A state machine with explicit durable boundaries doesn't need generic workflow
replay. At every suspension point, we know exactly what state the machine is in
(we already persist it). Recovery can be:

> Load last persisted `(stateValue, context)` from Postgres → resume the loop.

This is O(1) per machine instead of O(steps) per machine. Parked machines are
just rows in a table — zero in-memory footprint. A machine loads into memory
only when an event arrives, processes transitions (microseconds), and returns to
being a row.

## DBOS API Surface We Replace

Current usage mapped to what replaces it:

| DBOS API | Call Sites | Replacement |
|----------|-----------|-------------|
| `DBOS.recv()` | 1 — durable wait | pg `LISTEN/NOTIFY` on `machine_messages` + poll fallback |
| `DBOS.send()` | 1 — deliver event | `INSERT INTO machine_messages` |
| `DBOS.runStep()` | 3 — invoke, prompt send, prompt resolve | `INSERT INTO invoke_results` for caching + direct execution |
| `DBOS.setEvent("xstate.state")` | 6 — boundary persistence | `UPDATE machine_instances SET state_value, context` |
| `DBOS.setEvent("xstate.transitions")` | boundary persistence | `INSERT INTO transition_log` (append-only) or inline |
| `DBOS.setEvent("xstate.wakeAt")` | KEDA observability | `UPDATE machine_instances SET wake_at` (native column) |
| `DBOS.getEvent("xstate.state")` | 4 — read snapshot | `SELECT FROM machine_instances` |
| `DBOS.getEvent("xstate.transitions")` | visualization | `SELECT FROM transition_log` |
| `DBOS.registerWorkflow` | 1 | Not needed — no workflow registration |
| `DBOS.startWorkflow` | 1 | `INSERT INTO machine_instances` + start loop |
| `DBOS.retrieveWorkflow` | 1 | `SELECT FROM machine_instances` |
| `DBOS.listWorkflows` | 1 | `SELECT FROM machine_instances WHERE ...` |
| `DBOS.listWorkflowSteps` | 2 | `SELECT FROM invoke_results` |
| `DBOS.cancelWorkflow` | 1 | `UPDATE machine_instances SET status = 'cancelled'` |
| `DBOS.now()` | 4 — timestamps | `Date.now()` (no replay determinism needed) |
| `DBOS.workflowID` | 1 — context access | Passed as function argument |
| `DBOS.launch` / `DBOS.shutdown` / `DBOS.setConfig` | lifecycle | Pool creation / pool.end() |
| `DBOSClient.send` / `DBOSClient.getEvent` | external client | Direct SQL (same tables) |

## Schema

### `machine_instances`

One row per machine. The primary persistence target.

```sql
CREATE TABLE machine_instances (
  id              TEXT PRIMARY KEY,
  machine_name    TEXT NOT NULL,
  state_value     JSONB NOT NULL,
  context         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',
    -- running | done | error | cancelled
  wake_at         BIGINT,
    -- epoch ms of next after-delay timeout; NULL when no timeout
    -- native column — KEDA queries directly, no side-channel hack
  executor_id     TEXT,
    -- which process owns this machine (for cluster/reaper)
  input           JSONB,
    -- original input (auditability, restart)
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);

CREATE INDEX idx_machine_instances_status ON machine_instances (status);
CREATE INDEX idx_machine_instances_wake_at ON machine_instances (wake_at)
  WHERE wake_at IS NOT NULL AND status = 'running';
CREATE INDEX idx_machine_instances_machine_name ON machine_instances (machine_name);
```

### `invoke_results`

Cached side-effect results. Only needed for crash recovery during an invocation.
If we crash between "invoke started" and "invoke result persisted," we need to
know whether the side effect already ran.

```sql
CREATE TABLE invoke_results (
  instance_id     TEXT NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  step_key        TEXT NOT NULL,
    -- semantic key: "invoke:processPayment" or "prompt:pending_review"
    -- NOT positional — resilient to code changes
  output          JSONB,
  error           JSONB,
  started_at      BIGINT,
  completed_at    BIGINT,
  PRIMARY KEY (instance_id, step_key)
);
```

### `machine_messages`

Inbound event queue. `send()` inserts, the event loop consumes.

```sql
CREATE TABLE machine_messages (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id     TEXT NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  topic           TEXT NOT NULL DEFAULT 'event',
  payload         JSONB NOT NULL,
  consumed        BOOLEAN NOT NULL DEFAULT false,
  created_at      BIGINT NOT NULL
);

CREATE INDEX idx_machine_messages_pending
  ON machine_messages (instance_id, topic)
  WHERE consumed = false;

-- Notify listener on insert
CREATE OR REPLACE FUNCTION machine_messages_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('machine_event', NEW.instance_id || '::' || NEW.topic);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER machine_messages_trigger
  AFTER INSERT ON machine_messages
  FOR EACH ROW EXECUTE FUNCTION machine_messages_notify();
```

### `transition_log` (optional, replaces `xstate.transitions` event)

```sql
CREATE TABLE transition_log (
  instance_id     TEXT NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  seq             SERIAL,
  from_state      JSONB,
  to_state        JSONB NOT NULL,
  ts              BIGINT NOT NULL,
  PRIMARY KEY (instance_id, seq)
);
```

Append-only. No full-array rewrite on every transition (current approach
rewrites the entire `xstate.transitions` array via `setEvent`).

## Execution Model

### Normal operation (machine parked in durable state)

The machine is **not in memory**. It's a row in `machine_instances`.

```
1. External system: INSERT INTO machine_messages (instance_id, payload)
2. pg trigger: NOTIFY 'machine_event', 'order-123::event'
3. Listener callback fires in Node.js process
4. Load snapshot: SELECT state_value, context FROM machine_instances WHERE id = $1
5. Deserialize → XState snapshot
6. transition(machine, snapshot, event) — pure, instant
7. If new state is durable:
     UPDATE machine_instances SET state_value, context, wake_at, updated_at
     UPDATE machine_messages SET consumed = true
     Done. Machine returns to being a row.
8. If new state is an invocation:
     Check invoke_results for cached result (crash recovery)
     If not cached: execute side effect, INSERT into invoke_results
     transition(machine, snapshot, done/error event)
     Continue from step 7 (loop until durable or final)
9. If new state is final:
     UPDATE machine_instances SET status = 'done', state_value, context
     Done.
```

### Startup (machine creation)

```
1. INSERT INTO machine_instances (id, machine_name, state_value, context, status, input)
2. Run initial transitions in-memory (transient chain until durable/invoke/final)
3. If reaches durable state: UPDATE machine_instances, return handle
4. If reaches invocation: execute, continue until durable/final
5. Machine is now a row. Process can handle other work.
```

### Recovery (process restart)

**No replay.** No step cache walk. No re-execution from step 0.

```
1. SELECT id, wake_at FROM machine_instances
   WHERE status = 'running' AND executor_id = $me
2. For each machine with wake_at in the past:
     Load snapshot, fire the after-delay event, process transitions
3. For each machine with unconsumed messages:
     Load snapshot, process the message
4. Re-register LISTEN callbacks for active machines
```

This is O(machines-needing-attention), not O(all-machines × all-steps).

Machines that are simply parked and waiting? **Nothing to do.** They're rows.
When an event arrives, the NOTIFY fires and we handle it.

### Crash during invocation

This is the one case where we need the `invoke_results` cache:

```
1. Machine in "processing" state, about to call processPayment
2. Check invoke_results for (instance_id, "invoke:processPayment")
3. Not found → execute the side effect
4. INSERT INTO invoke_results (output, completed_at)
   -- ON CONFLICT DO NOTHING (idempotent)
5. transition(snapshot, done event)
6. Persist new state to machine_instances
```

If we crash between step 3 and step 4: the side effect ran but the result
wasn't persisted. On recovery, step 2 finds no cached result, and the side
effect runs again. This is the same risk DBOS has — `runStep` has the same
window. For truly exactly-once side effects, the side effect itself must be
idempotent (standard DBOS guidance).

If we crash between step 4 and step 6: the result is cached. On recovery,
step 2 finds the cached result, skips execution, transitions normally.

## Architecture

### Core module: `PgMachineStore`

~500 lines. Replaces DBOS's `SystemDatabase` (3000+ lines).

```typescript
class PgMachineStore {
  constructor(pool: Pool);

  // Instance lifecycle
  createInstance(id, machineName, stateValue, context, input): Promise<void>;
  updateInstance(id, stateValue, context, wakeAt?): Promise<void>;
  completeInstance(id, stateValue, context, status): Promise<void>;
  getInstance(id): Promise<MachineRow | null>;
  listInstances(filter?): Promise<MachineRow[]>;
  cancelInstance(id): Promise<void>;

  // Messages (recv/send)
  sendMessage(instanceId, payload, topic?): Promise<void>;
  consumeMessage(instanceId, topic?): Promise<JSONB | null>;
  listenForMessages(callback: (instanceId, topic) => void): Promise<void>;

  // Invoke results (step cache)
  getInvokeResult(instanceId, stepKey): Promise<JSONB | null>;
  recordInvokeResult(instanceId, stepKey, output, error?): Promise<void>;

  // Transition log (optional)
  appendTransition(instanceId, from, to, ts): Promise<void>;
  getTransitions(instanceId): Promise<TransitionRecord[]>;

  // Recovery
  getInstancesNeedingAttention(executorId): Promise<MachineRow[]>;

  // Lifecycle
  close(): Promise<void>;
}
```

### Event loop: `MachineEventLoop`

Replaces the DBOS workflow function. Instead of a suspended async function per
machine, it's an event-driven dispatcher.

```typescript
class MachineEventLoop {
  constructor(store: PgMachineStore, machines: Map<string, AnyStateMachine>);

  // Called on NOTIFY — loads snapshot, processes event, persists result
  handleEvent(instanceId: string, event: AnyEventObject): Promise<void>;

  // Called on timeout — loads snapshot, fires after-delay
  handleTimeout(instanceId: string): Promise<void>;

  // Startup
  recoverPending(executorId: string): Promise<void>;
  startTimeoutChecker(intervalMs?: number): void;
}
```

### Timeout handling

Two approaches, pick one:

**A. Polling (simpler).** A setInterval checks
`SELECT id FROM machine_instances WHERE wake_at < now() AND status = 'running'`
every N seconds. Good enough for most cases. DBOS's recv timeout works this way
under the hood (polling + LISTEN/NOTIFY).

**B. Per-machine setTimeout (lower latency).** On startup, load all machines
with `wake_at` and create in-memory timers. On new machine with `wake_at`,
create a timer. Timer fires → load snapshot → process. Risk: many timers
consume memory (but only a timer handle, not a full closure — much less than a
suspended workflow). Timers that fire while the process is down get caught by
the recovery poll on restart.

**Recommendation:** Start with A. It's what DBOS effectively does. If sub-second
timeout precision matters, add B as an optimization.

### LISTEN/NOTIFY with fallback

Lift the pattern from DBOS's `system_database.ts`:

```typescript
// Dedicated connection for LISTEN (not from pool — long-lived)
const listenClient = new Client(connectionString);
await listenClient.connect();
await listenClient.query("LISTEN machine_event");

listenClient.on("notification", (msg) => {
  const [instanceId, topic] = msg.payload.split("::");
  eventLoop.handleEvent(instanceId, topic);
});

// Self-test: detect transaction-mode poolers (PgBouncer) that break LISTEN
// If broken, fall back to polling machine_messages every 100ms
```

### Public API (unchanged)

The `DurableMachine` and `DurableMachineHandle` interfaces stay identical.
The implementation changes from DBOS calls to `PgMachineStore` calls:

```typescript
// Before (DBOS)
async send(event) { await DBOS.send(workflowId, event, "xstate.event"); }
async getState() { return DBOS.getEvent(workflowId, "xstate.state", 0.1); }

// After (direct Postgres)
async send(event) { await store.sendMessage(workflowId, event); }
async getState() { return store.getInstance(workflowId); }
```

## What We Gain

| Property | DBOS (current) | Direct Postgres |
|----------|---------------|-----------------|
| Memory per parked machine | 2-10KB (suspended closure) | **0** (row in Postgres) |
| 10K parked machines | 20-100MB | 0 |
| Startup recovery | O(machines × steps) queries | **O(machines needing attention)** |
| State queries | Generic KV (TEXT blobs) | **JSONB** — queryable: `WHERE context->>'orderId' = 'x'` |
| Timeout tracking | Side-channel via `setEvent` | **Native column**, directly indexable |
| Step identity | Positional `function_id` (fragile) | **Semantic keys** (resilient to code changes) |
| Transition history | Full-array rewrite via `setEvent` | **Append-only table** |
| External client | `DBOSClient` (reimplements send/getEvent) | **Raw SQL** — anyone with a pg connection |
| Dependency | `@dbos-inc/dbos-sdk` (~4000 lines runtime) | **`pg`** (~0 lines runtime overhead) |
| Persistence writes per transition | 2+ (operation_outputs + workflow_events) | **1** (UPDATE machine_instances) |

## What We Lose

- **DBOS Cloud / Conductor compatibility.** If we want managed DBOS hosting
  later, we'd need an adapter.
- **DBOS ecosystem tooling.** CLI, migration commands, admin UI.
- **`DBOS.now()` determinism.** Not needed — we don't replay.
- **Battle-tested edge case handling.** DBOS handles serialization failures
  (Postgres 40001), lock timeouts, concurrent writes. We need to handle these
  ourselves, but the patterns are visible in their source to crib from.
- **Workflow queues.** DBOS's queue (concurrency, rate limiting, priority,
  partitioning, dedup) is the most sophisticated feature we skip. If we need
  batch machine creation with backpressure, we'd build a simpler version later.

## Implementation Phases

### Phase 1: `PgMachineStore` + schema + migrations

- Schema creation (3 tables + triggers + indexes)
- `PgMachineStore` class with all CRUD operations
- LISTEN/NOTIFY setup with PgBouncer fallback detection
- Unit tests against a test Postgres (same Docker setup we already have)

### Phase 2: `MachineEventLoop` + snapshot-based execution

- Event-driven machine processing (load → transition → persist)
- Invocation execution with `invoke_results` caching
- Timeout handling (polling approach)
- Prompt dispatch integration (channel adapters are unchanged)

### Phase 3: Replace `create-durable-machine.ts` + `machine-loop.ts`

- New `createDurableMachine()` backed by `PgMachineStore` + `MachineEventLoop`
- Same public API (`DurableMachine`, `DurableMachineHandle`)
- Update visualization to read from new tables
- Update external client helpers

### Phase 4: Migration path

- Migration script to convert existing DBOS `workflow_status` +
  `workflow_events` rows into `machine_instances` rows (for existing users)
- Remove `@dbos-inc/dbos-sdk` dependency

### Phase 5: Optimizations (optional)

- Per-machine setTimeout for sub-second timeout precision
- Connection pool tuning for high-throughput event delivery
- Batch message consumption (process multiple events for one machine in
  a single load-transition-persist cycle)
- Optional queue for batch `start()` with concurrency/rate limiting

## Risks

### Invoke idempotency window

Between "side effect executed" and "result persisted in invoke_results," a crash
means the side effect re-executes on recovery. This is identical to DBOS's
`runStep` behavior. Mitigation: document that invoked actors should be
idempotent (same as current guidance).

### LISTEN/NOTIFY reliability

pg LISTEN/NOTIFY is unreliable through transaction-mode connection poolers
(PgBouncer in transaction mode). DBOS handles this with a self-test and polling
fallback. We lift the same pattern.

### Concurrent event delivery

Two events arriving simultaneously for the same machine could race: both load
the snapshot, both transition, one overwrites the other. Mitigation: `SELECT
... FOR UPDATE` on `machine_instances` when processing an event serializes
concurrent access per machine. Or use optimistic concurrency with an
`updated_at` check.

### Schema migrations

We own the schema now, so we own migrations. Use a simple migration runner
(or just version-numbered SQL files + a `schema_version` table).

## Size Estimate

| Component | Lines |
|-----------|-------|
| Schema (SQL) | ~60 |
| `PgMachineStore` | ~400 |
| `MachineEventLoop` | ~200 |
| LISTEN/NOTIFY + fallback | ~80 |
| Updated `createDurableMachine` | ~100 |
| Updated visualization queries | ~50 |
| Migration script | ~50 |
| **Total** | **~940** |

Replacing ~4000 lines of DBOS runtime dependency with ~940 lines of
purpose-built code.
