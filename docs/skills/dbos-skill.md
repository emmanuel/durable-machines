# DBOS Transact TypeScript — Development Skill Guide

> Authoritative reference for building durable TypeScript applications with DBOS Transact.
> Covers the full API surface, architecture, patterns, gotchas, and production operations.
> Based on DBOS Transact v4.x (current as of early 2026).

---

## What DBOS Is

DBOS Transact is an open-source durable execution library for TypeScript (also available for Python, Go, and Java). It makes programs resilient to any failure by checkpointing workflow and step state to a Postgres database. If a program is ever interrupted or crashes, workflows automatically resume from the last completed step on restart.

DBOS is **not** an external orchestration server. It is a library you install into your application (`@dbos-inc/dbos-sdk`). The only external dependency is a Postgres database (the "system database"). There is no separate workflow server, no message broker, and no additional infrastructure to manage.

---

## Core Concepts

### Workflows

A **workflow** is a function whose execution is made durable. DBOS records its inputs when it starts and checkpoints the output of each step as it runs. If the process crashes and restarts, DBOS replays the workflow from the beginning, returning cached results for all previously completed steps, until it reaches the point of interruption and resumes normal execution.

**Critical constraint: workflow functions must be deterministic.** Given the same inputs and the same step return values, they must invoke the same steps in the same order. All non-determinism (API calls, database access, random numbers, current time) must be wrapped in steps.

Workflow inputs and outputs must be JSON-serializable (or serializable by a custom serializer if configured).

### Steps

A **step** is a unit of work within a workflow whose result is checkpointed. Once a step completes (returns a value or throws an exception), it is never re-executed — on recovery, DBOS returns the cached result. Steps are the boundary between deterministic workflow logic and non-deterministic external operations.

Steps can be configured with automatic retries (exponential backoff) for transient failures.

### Transactions

A **transaction** is a special kind of step that runs inside a database transaction. The transaction's result is recorded in the same database transaction, guaranteeing exactly-once execution even across retries and failures. Transactions require a datasource plugin (e.g., Knex, Drizzle, Prisma).

### Queues

**Workflow queues** provide flow control for background workflow execution. You can configure concurrency limits (per-process and global), rate limits, priorities, deduplication, and queue partitioning.

### Events and Messages

**Events** (`setEvent`/`getEvent`) are key-value pairs published by a workflow, readable by external consumers. They represent the "latest state" of something and are overwritten on update.

**Messages** (`send`/`recv`) are durable notifications sent to a specific workflow. They are enqueued per-topic and consumed FIFO. `recv` blocks the workflow until a message arrives or a timeout expires.

### Streams

**Streams** (`writeStream`/`readStream`/`closeStream`) allow a workflow to emit ordered values that external consumers can read as an async generator in real-time.

---

## Registration Styles

DBOS supports three equivalent registration styles. Use whichever fits your codebase.

### Style 1: Decorators on Static Class Methods

```ts
import { DBOS } from "@dbos-inc/dbos-sdk";

export class OrderService {
  @DBOS.workflow()
  static async processOrder(orderId: string): Promise<string> {
    const result = await OrderService.chargePayment(orderId);
    await OrderService.sendConfirmation(orderId, result);
    return result;
  }

  @DBOS.step({ retriesAllowed: true, maxAttempts: 5, intervalSeconds: 2, backoffRate: 2 })
  static async chargePayment(orderId: string): Promise<string> {
    // Call external payment API
    return `charge_${orderId}`;
  }

  @DBOS.step()
  static async sendConfirmation(orderId: string, chargeId: string): Promise<void> {
    // Send email
  }
}
```

### Style 2: `registerWorkflow` / `registerStep` (Functional)

```ts
import { DBOS } from "@dbos-inc/dbos-sdk";

async function chargePaymentFn(orderId: string): Promise<string> {
  return `charge_${orderId}`;
}
const chargePayment = DBOS.registerStep(chargePaymentFn, {
  name: "chargePayment",
  retriesAllowed: true,
  maxAttempts: 5,
});

async function processOrderFn(orderId: string): Promise<string> {
  const result = await chargePayment(orderId);
  return result;
}
const processOrder = DBOS.registerWorkflow(processOrderFn, { name: "processOrder" });
```

### Style 3: Inline `DBOS.runStep`

```ts
import { DBOS } from "@dbos-inc/dbos-sdk";

async function processOrderFn(orderId: string): Promise<string> {
  const chargeId = await DBOS.runStep(
    () => callPaymentAPI(orderId),
    { name: "chargePayment", retriesAllowed: true, maxAttempts: 5 }
  );
  await DBOS.runStep(
    () => sendEmail(orderId, chargeId),
    { name: "sendConfirmation" }
  );
  return chargeId;
}
const processOrder = DBOS.registerWorkflow(processOrderFn, { name: "processOrder" });
```

**When to use which:**
- Decorators: when you prefer class-based organization and want the cleanest syntax.
- `registerWorkflow`/`registerStep`: when you prefer standalone functions or need to register dynamically.
- `DBOS.runStep`: when wrapping ad-hoc or one-off operations inline. Good for quick prototyping or when a dedicated step function would be overkill.

All three are equivalent at runtime. You can mix them in the same application.

---

## Application Lifecycle

```ts
import { DBOS } from "@dbos-inc/dbos-sdk";

// 1. Configure
DBOS.setConfig({
  name: "my-app",
  systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL,
  // Optional:
  // applicationVersion: "1.0.0",
  // executorID: "worker-1",
  // systemDatabasePoolSize: 10,   // default varies; minimum 5
  // logLevel: "info",
  // runAdminServer: true,         // default true
  // adminPort: 3001,              // default 3001
});

// 2. Register all workflows, steps, queues, scheduled functions, datasources, instances
//    (decorators register automatically when the class is loaded)

// 3. Launch
await DBOS.launch();
// DBOS is now running. It:
//   - Connects to Postgres
//   - Creates system tables if needed
//   - Recovers any interrupted PENDING workflows owned by this executor
//   - Starts queue polling and scheduled workflows

// 4. Run your application (Express, Next.js, standalone script, etc.)

// 5. Shutdown
await DBOS.shutdown();
```

**Important ordering:** All registrations (workflows, steps, queues, datasources, ConfiguredInstance subclasses) must happen **before** `DBOS.launch()`. DBOS builds an internal registry at launch time; anything registered after will not be found during recovery.

**Bundler warning:** DBOS cannot be bundled with Webpack, Vite, Rollup, esbuild, or Parcel. It must be treated as an external dependency. This is because DBOS's internal workflow registry relies on runtime function identity.

**Node.js requirement:** Node.js 20 or later.

---

## The Full API Surface

### Workflow Operations (call from within a workflow)

| Method | Purpose |
|---|---|
| `DBOS.runStep(fn, config?)` | Run a function as a checkpointed step |
| `DBOS.sleep(ms)` | Durable sleep — survives restarts |
| `DBOS.send(workflowID, message, topic?, idempotencyKey?)` | Send a durable message to another workflow |
| `DBOS.recv(topic?, timeoutSeconds?)` | Wait for and dequeue a message (default 60s timeout) |
| `DBOS.setEvent(key, value)` | Publish a key-value event for external consumers |
| `DBOS.getEvent(workflowID, key, timeoutSeconds?)` | Read another workflow's event (waits if not yet set) |
| `DBOS.startWorkflow(target, params?)(args)` | Start a child/background workflow, returns a handle |
| `DBOS.now()` | Checkpointed current time (use instead of `Date.now()`) |
| `DBOS.randomUUID()` | Checkpointed UUID (use instead of `crypto.randomUUID()`) |
| `DBOS.writeStream(key, value)` | Write a value to a named stream |
| `DBOS.closeStream(key)` | Close a named stream |
| `DBOS.patch(patchName)` | Insert a patch marker for safe code upgrades |
| `DBOS.deprecatePatch(patchName)` | Bypass a patch marker |

### Context Variables (available in workflows and steps)

| Variable | Type | Purpose |
|---|---|---|
| `DBOS.workflowID` | `string \| undefined` | Current workflow ID |
| `DBOS.stepID` | `number \| undefined` | Current step's sequential ID |
| `DBOS.stepStatus` | `StepStatus \| undefined` | Current retry attempt info |
| `DBOS.isInStep()` | `boolean` | Are we in a step? |
| `DBOS.isInTransaction()` | `boolean` | Are we in a transaction? |
| `DBOS.executorID` | `string` | This process's executor ID |
| `DBOS.applicationVersion` | `string` | Current app version |
| `DBOS.logger` | `Logger` | Pre-configured Winston logger |
| `DBOS.span` | `Span \| undefined` | OpenTelemetry span |

### Workflow Management (call from anywhere)

| Method | Purpose |
|---|---|
| `DBOS.retrieveWorkflow(id)` | Get a handle to a workflow by ID |
| `DBOS.getWorkflowStatus(id)` | Get the status of a workflow |
| `DBOS.listWorkflows(filter)` | Query workflows by status, name, time range, etc. |
| `DBOS.listWorkflowSteps(id)` | Get the step history of a workflow |
| `DBOS.listQueuedWorkflows(filter)` | List currently enqueued workflows |
| `DBOS.cancelWorkflow(id)` | Cancel a running or enqueued workflow |
| `DBOS.resumeWorkflow(id)` | Resume a cancelled or dead-letter workflow |
| `DBOS.deleteWorkflow(id, deleteChildren?)` | Permanently delete a workflow |
| `DBOS.forkWorkflow(id, startStep, options?)` | Fork a workflow from a specific step |
| `DBOS.readStream(workflowID, key)` | Read a workflow's stream as an async generator |

### DBOSClient (External Access)

`DBOSClient` connects to the DBOS system database from outside the DBOS runtime. It provides the same management and messaging capabilities without requiring a running DBOS process.

```ts
import { DBOSClient } from "@dbos-inc/dbos-sdk";

const client = await DBOSClient.create({
  systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL!,
});

// Enqueue a workflow
const handle = await client.enqueue({ workflowName: "processOrder", queueName: "orders" }, orderId);

// Send a message to a running workflow
await client.send(workflowId, { type: "APPROVE" }, "events");

// Read a workflow's published event
const state = await client.getEvent(workflowId, "currentState");

// List workflows, cancel, resume, fork — all available
await client.destroy();
```

Use `DBOSClient` for webhook gateways, CLI tools, admin scripts, cross-service communication, and any code that needs to interact with DBOS workflows without running the DBOS runtime itself.

---

## Step Configuration

```ts
interface StepConfig {
  retriesAllowed?: boolean;   // Enable automatic retries (default: false)
  intervalSeconds?: number;   // Initial retry delay in seconds (default: 1)
  maxAttempts?: number;       // Max retry attempts (default: 3)
  backoffRate?: number;       // Multiplier for intervalSeconds between retries (default: 2)
  name?: string;              // Step name (used in logging, step history, recovery matching)
}
```

If a step exhausts all retry attempts, it throws `DBOSMaxStepRetriesError` to the calling workflow. If an **uncaught** exception propagates out of the workflow, the workflow terminates with status `ERROR` and is **not** automatically recovered (uncaught exceptions are assumed non-recoverable).

**Best practice:** Wrap transient failures (HTTP calls, external APIs) in steps with retries. Let non-recoverable errors (validation failures, business logic errors) propagate up to terminate the workflow.

---

## Queues

```ts
import { DBOS, WorkflowQueue } from "@dbos-inc/dbos-sdk";

const queue = new WorkflowQueue("processing_queue", {
  workerConcurrency: 5,              // Max concurrent per process
  concurrency: 20,                   // Max concurrent globally
  rateLimit: {
    limitPerPeriod: 100,             // Max starts per period
    periodSec: 60,                   // Period in seconds
  },
  priorityEnabled: true,             // Enable priority ordering
  partitionQueue: false,             // Enable partitioned flow control
});

// Enqueue a workflow
const handle = await DBOS.startWorkflow(processOrder, {
  queueName: queue.name,
  enqueueOptions: {
    priority: 1,                     // Lower number = higher priority
    deduplicationID: `order-${id}`,  // Prevent duplicate enqueue
  },
})(orderId);
```

**Queue rules:**
- Queues must be created before `DBOS.launch()`.
- Enqueued workflows go to status `ENQUEUED`, then `PENDING` when dequeued.
- `workerConcurrency` requires unique `executorID` per process (set automatically by Conductor; must be set manually otherwise).
- `DBOS.startWorkflow` with a `queueName` is durable — after it returns, the workflow is guaranteed to eventually execute.
- You can use `listenQueues` in config to restrict which queues a process dequeues from (useful for heterogeneous workers, e.g., CPU vs GPU).

---

## Scheduled Workflows

```ts
@DBOS.workflow()
@DBOS.scheduled({ crontab: "*/30 * * * * *" })   // Every 30 seconds (6-field cron with seconds)
static async periodicCleanup(scheduledTime: Date, startTime: Date) {
  // scheduledTime: when this was supposed to run
  // startTime: when it actually started
}
```

Or functional style:

```ts
const cleanup = DBOS.registerWorkflow(cleanupFn);
DBOS.registerScheduled(cleanup, {
  crontab: "0 */5 * * *",             // Every 5 minutes (5-field standard cron)
  mode: SchedulerMode.ExactlyOncePerInterval,  // Also run missed intervals from downtime
  queueName: "maintenance",           // Optional: route through a queue
});
```

---

## Messaging Patterns

### send/recv — Inter-Workflow Communication

```ts
// Sender (from another workflow, or from external code via DBOS.send or DBOSClient.send)
await DBOS.send(targetWorkflowId, { type: "APPROVE", user: "alice" }, "events");

// Receiver (inside the target workflow)
const event = await DBOS.recv<{ type: string; user: string }>("events", 3600);
// Returns null on timeout
if (!event) { /* handle timeout */ }
```

Messages are durable, enqueued per-topic, and consumed FIFO. If no message is available, `recv` blocks the workflow (durably — survives restarts) until one arrives or the timeout expires.

**Default timeout:** 60 seconds. Always specify an explicit timeout for long waits.

### setEvent/getEvent — Publish/Subscribe State

```ts
// Publisher (inside a workflow)
await DBOS.setEvent("status", { state: "processing", progress: 42 });

// Consumer (from anywhere)
const status = await DBOS.getEvent(workflowId, "status", 30);
// Returns the latest value, or waits up to 30s for it to be set
```

Events are **not** queued — they represent the latest value of a key. `setEvent` overwrites the previous value. Use events for "current state" and messages for "things that happened."

---

## Determinism Rules

Workflow functions **must** be deterministic on replay. These operations are **unsafe** directly in a workflow and must be wrapped in steps:

| Unsafe in Workflow | Safe Alternative |
|---|---|
| `Date.now()` | `await DBOS.now()` |
| `Math.random()` | `await DBOS.runStep(() => Promise.resolve(Math.random()), { name: "random" })` |
| `crypto.randomUUID()` | `await DBOS.randomUUID()` |
| `fetch()` / HTTP calls | Wrap in `DBOS.runStep` or `@DBOS.step()` |
| Database queries | Use `@DBOS.step()` or a datasource transaction |
| File system access | Wrap in `DBOS.runStep` |
| Any non-deterministic I/O | Wrap in `DBOS.runStep` |

**What IS safe directly in a workflow:** branching on step return values, loops with deterministic bounds, string manipulation, `JSON.parse`/`JSON.stringify`, pure computation, `assign` operations, calling other steps.

---

## Transactions & Datasources

DBOS provides exactly-once database transactions through datasource plugins. Each datasource is a separate npm package:

- `@dbos-inc/knex-datasource` — Knex query builder
- `@dbos-inc/drizzle-datasource` — Drizzle ORM
- `@dbos-inc/prisma-datasource` — Prisma ORM
- `@dbos-inc/typeorm-datasource` — TypeORM

```ts
import { KnexDataSource } from "@dbos-inc/knex-datasource";

const ds = new KnexDataSource("appDb", { client: "pg", connection: process.env.DATABASE_URL });

// Decorator style
class Repo {
  @ds.transaction()
  static async insertOrder(orderId: string, total: number) {
    await ds.client.raw("INSERT INTO orders (id, total) VALUES (?, ?)", [orderId, total]);
  }
}

// Or functional
const insertOrder = ds.registerTransaction(async (orderId: string, total: number) => {
  await ds.client.raw("INSERT INTO orders (id, total) VALUES (?, ?)", [orderId, total]);
});

// Or inline
await ds.runTransaction(async () => {
  await ds.client.raw("INSERT INTO orders (id, total) VALUES (?, ?)", [orderId, total]);
}, { name: "insertOrder" });
```

**Exactly-once guarantee:** The datasource writes the transaction's result to a checkpoint table inside the same database transaction. On recovery, if the checkpoint already exists, the transaction is not re-executed.

**Important:** Transactions are a special kind of step. They can only be called from within workflows (or standalone, but without durability guarantees). The application database and the system database can be the same Postgres instance or different ones.

---

## System Database & Tables

DBOS stores all its state in a Postgres database under the `dbos` schema. Key tables:

| Table | Purpose |
|---|---|
| `dbos.workflow_status` | One row per workflow execution: ID, status, name, inputs, output, error, timestamps, executor_id, version |
| `dbos.operation_outputs` | One row per step execution: workflow_uuid, function_id (sequential), name, output, error, timestamps |
| `dbos.notifications` | Durable messages (send/recv): destination_uuid, topic, message, timestamp |
| `dbos.workflow_events` | Published events (setEvent): workflow_uuid, key, value |
| `dbos.workflow_events_history` | Historic event values with step IDs |
| `dbos.streams` | Stream messages: workflow_uuid, key, value, offset |
| `dbos.workflow_schedules` | Cron schedule definitions |

**Workflow statuses:** `ENQUEUED`, `PENDING`, `SUCCESS`, `ERROR`, `CANCELLED`, `MAX_RECOVERY_ATTEMPTS_EXCEEDED`.

**DB overhead per workflow:** one write at start (inputs), one write per step (output), one write at end (final status). Write sizes are proportional to your input/output sizes.

**You can query these tables directly** with `psql`, DBeaver, or any Postgres client. This is useful for building custom dashboards, migration scripts, or debugging.

---

## Recovery Model

When DBOS launches, it scans for workflows with status `PENDING` that belong to this executor (matched by `executor_id`). For each, it calls the workflow function again with the original checkpointed inputs. As the workflow re-executes:

1. Each `DBOS.runStep` checks `dbos.operation_outputs` for a matching `function_id`.
2. If a checkpoint exists, the step returns the cached output instantly (no re-execution).
3. If no checkpoint exists, this is where the original execution was interrupted. The step executes normally and checkpoints its result.
4. The workflow continues from this point forward.

**Recovery is replay-based, not snapshot-based.** The workflow function runs from the beginning every time. This is why determinism is critical — the workflow must reach the same steps in the same order to match up with existing checkpoints.

**What happens with concurrent recovery:** If two processes try to recover the same workflow (e.g., by calling `startWorkflow` with an existing ID), the first to complete each step writes the checkpoint. The second sees the checkpoint already exists and returns the cached result. Both converge to the same outcome.

---

## Distributed Deployment

### Architecture

Multiple processes can run the same DBOS application, all connecting to the same system database. Each process has a unique `executorID`. DBOS uses this ID to track which process owns which workflows.

### Conductor (Recommended for Production)

DBOS Conductor is a management service that provides:
- **Distributed recovery:** detects when an executor fails (via closed websocket) and reassigns its workflows to a healthy executor.
- **Observability:** dashboards for workflows, queues, step history, execution graphs.
- **Management:** pause, resume, cancel, fork workflows from a web UI.
- **Retention policies:** manage how much workflow history to retain.

Conductor is **out-of-band** — it communicates exclusively over websockets, never accesses your database directly, and is never on the critical path of workflow execution. If Conductor goes down, your application continues running; recovery of failed workflows is delayed until the connection is restored.

```ts
// Connect to Conductor
await DBOS.launch({ conductorKey: process.env.DBOS_CONDUCTOR_KEY });
```

Conductor can be used as a hosted service (DBOS Cloud) or self-hosted (Docker Compose, Kubernetes). Self-hosting for commercial/production use requires a license key.

### Without Conductor

For self-hosted deployments that don't use Conductor, you must handle recovery yourself:
- On a single-node deployment, DBOS automatically recovers all `PENDING` workflows at startup.
- On a multi-node deployment, you need a mechanism to detect dead executors and reassign their workflows (e.g., a heartbeat + reaper pattern querying `dbos.workflow_status`).

Set `executorID` to a unique value per process in config, or use a fixed value if you only run one replica.

---

## Upgrading Workflow Code

A **breaking change** to a workflow is one that changes which steps are run or their order. DBOS supports two strategies:

### Patching

Use `DBOS.patch()` to conditionally execute new code:

```ts
async function myWorkflow() {
  if (await DBOS.patch("add-validation-step")) {
    // New code: runs for workflows started after the patch
    await DBOS.runStep(() => validateInput(), { name: "validate" });
  }
  // Original code continues
  await DBOS.runStep(() => process(), { name: "process" });
}
```

`DBOS.patch()` returns `true` for new workflows, `false` for workflows that were in-flight before the patch. Once all old workflows complete, deprecate with `DBOS.deprecatePatch()`, then remove the patch entirely.

### Versioning

Tag each deployment with an `applicationVersion`. DBOS only recovers workflows whose version matches the current application version. Deploy new code with a new version string, keep old instances running to drain old workflows:

```ts
DBOS.setConfig({
  name: "my-app",
  applicationVersion: "2.0.0",
  systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL,
});
```

By default, `applicationVersion` is auto-computed from a hash of your workflow source code.

### Forking

Use `DBOS.forkWorkflow()` to restart a failed workflow from a specific step on a new code version. Useful for recovering from downstream outages or patching bugs in production.

---

## Debouncing

Debouncing delays workflow execution until some time has passed since the last invocation. Useful for preventing wasted work on rapid-fire triggers.

```ts
const debouncer = new Debouncer({
  workflow: processInput,
  debounceTimeoutMs: 300000,  // Max total delay: 5 minutes
});

// Each call resets the debounce timer. The workflow runs 60s after the LAST call.
// When it runs, it uses the LAST set of arguments.
await debouncer.debounce("user-123", 60000, latestInput);
```

---

## Testing

### Unit Testing Workflow Logic

Test workflow determinism and branching without DBOS or Postgres. Mock your steps and call the workflow function directly, or test step functions in isolation.

### Integration Testing with DBOS

```ts
import { DBOS } from "@dbos-inc/dbos-sdk";

beforeAll(async () => {
  DBOS.setConfig({
    name: "test-app",
    systemDatabaseUrl: process.env.TEST_DBOS_SYSTEM_DATABASE_URL,
  });
  await DBOS.launch();
});

afterAll(async () => {
  await DBOS.shutdown({ deregister: true });
  // deregister: true clears all registrations so the next test suite starts clean
});

test("workflow completes", async () => {
  const handle = await DBOS.startWorkflow(myWorkflow)("input");
  const result = await handle.getResult();
  expect(result).toBe("expected");
});
```

**Tip:** Use `DBOS.shutdown({ deregister: true })` in tests to reset state between test suites.

---

## Common Patterns

### Background Task with Status Polling

```ts
// Start
const handle = await DBOS.startWorkflow(processData, { workflowID: `job-${jobId}` })(data);

// Poll from client
const status = await DBOS.getWorkflowStatus(`job-${jobId}`);
// Or read published events
const progress = await DBOS.getEvent(`job-${jobId}`, "progress");
```

### Workflow-to-Workflow Communication

```ts
// Parent starts child and waits for result
async function parentWorkflow() {
  const childHandle = await DBOS.startWorkflow(childWorkflow)("input");
  const result = await childHandle.getResult();
}

// Or: fire-and-forget with event notification
async function parentWorkflow() {
  await DBOS.startWorkflow(childWorkflow)("input");
  // Child publishes event when done; parent can move on
}
```

### Human-in-the-Loop (Approval Pattern)

```ts
async function approvalWorkflow(requestId: string, reviewerId: string) {
  // Send notification (via step)
  await DBOS.runStep(() => notifyReviewer(reviewerId, requestId), { name: "notify" });

  // Wait for human response (up to 72 hours)
  const response = await DBOS.recv<{ decision: string }>("approval", 259200);

  if (!response || response.decision === "reject") {
    return "rejected";
  }

  await DBOS.runStep(() => processApproval(requestId), { name: "processApproval" });
  return "approved";
}

// External system sends the decision:
await DBOS.send(workflowId, { decision: "approve" }, "approval");
// Or via DBOSClient from a webhook handler
```

### Idempotent Workflow Start

```ts
// Starting a workflow with the same ID is idempotent:
// - If the workflow doesn't exist: starts it normally
// - If it's currently running: returns a handle to the existing execution
// - If it completed: returns the previous result
const handle = await DBOS.startWorkflow(processOrder, {
  workflowID: `order-${orderId}`,
})(orderId);
```

### Fan-out / Fan-in with Queues

```ts
async function batchProcessor(items: string[]) {
  const handles = [];
  for (const item of items) {
    handles.push(
      await DBOS.startWorkflow(processItem, { queueName: "processing" })(item)
    );
  }
  const results = [];
  for (const h of handles) {
    results.push(await h.getResult());
  }
  return results;
}
```

---

## Production Checklist

1. **Postgres:** Use a production-grade Postgres instance (RDS, CloudSQL, Supabase, Neon, CockroachDB). Pool size minimum 5.
2. **Connection pooler:** If using PgBouncer, use **session mode only** (not transaction mode).
3. **Conductor:** Connect to DBOS Conductor for distributed recovery and observability.
4. **Executor ID:** Set a unique `executorID` per process if not using Conductor (Conductor sets it automatically).
5. **Application version:** Set `applicationVersion` explicitly for reproducible deployments and safe upgrades.
6. **Schema migration:** In restricted environments, run `npx dbos schema` with a privileged user to create system tables, then run the app with minimum permissions.
7. **Serialization:** Ensure all workflow inputs, outputs, and step outputs are JSON-serializable.
8. **Step naming:** Always provide explicit `name` values for `DBOS.runStep` calls. Names are used in recovery, logging, and the step history UI.
9. **Max recovery attempts:** Set `maxRecoveryAttempts` on workflows that might crash the process to prevent infinite recovery loops (acts as a dead letter queue).
10. **Bundler exclusion:** Mark `@dbos-inc/dbos-sdk` as external in any bundler config.
11. **Retention:** Configure workflow history retention in Conductor to prevent unbounded table growth.
12. **Observability:** Enable OTLP export for traces and logs if you use an observability platform.

---

## Gotchas and Pitfalls

1. **Non-deterministic workflows.** The #1 source of bugs. If you use `Date.now()`, `Math.random()`, or make an API call directly in a workflow function (outside a step), recovery will produce different results and checkpoints will not match. Use `DBOS.now()`, `DBOS.randomUUID()`, or wrap in `DBOS.runStep`.

2. **Unserializable inputs/outputs.** Workflow inputs, step outputs, and workflow results must be JSON-serializable. Passing database connections, class instances with methods, or circular references will fail silently or throw.

3. **Uncaught exceptions terminate workflows.** If an exception escapes a workflow function, the workflow is marked `ERROR` and is **not** recovered. Retries should happen at the step level. If you want a workflow to be recoverable on certain errors, catch them and handle them explicitly.

4. **Step nesting.** You can call a step from another step, but the inner step does **not** get its own checkpoint — it becomes part of the outer step's execution. Only top-level step calls within a workflow are checkpointed.

5. **Cannot start workflows from steps.** `DBOS.startWorkflow` can only be called from workflow functions or from outside DBOS. Calling it from within a step will fail.

6. **recv default timeout is 60 seconds.** If you're building a long-running approval workflow, you must specify an explicit timeout. `recv` returns `null` on timeout.

7. **Event semantics are last-write-wins.** `setEvent` overwrites the previous value. If you need an ordered log, use `writeStream` instead.

8. **Queue stuck?** If workflows aren't moving from `ENQUEUED` to `PENDING`, check: (a) concurrency limit reached, (b) rate limit reached, (c) no process is listening to that queue, (d) `executorID` not set (needed for `workerConcurrency`).

9. **Workflow ID reuse.** Starting a workflow with an ID that already exists returns the existing execution. This is by design (idempotency) but can be surprising if you're reusing IDs unintentionally.

10. **PgBouncer transaction mode.** DBOS requires session-mode pooling. Transaction-mode pooling breaks DBOS's multi-statement transaction patterns.

---

## CLI Reference (Key Commands)

```bash
# Create system tables with elevated privileges
npx dbos schema -s $DBOS_SYSTEM_DATABASE_URL

# List workflows
npx dbos workflow list --status PENDING --limit 10

# Get workflow steps
npx dbos workflow steps <workflow-id>

# Cancel a workflow
npx dbos workflow cancel <workflow-id>

# Resume a cancelled/errored workflow
npx dbos workflow resume <workflow-id>

# Fork a workflow from a specific step
npx dbos workflow fork <workflow-id> --start-step <step-id>

# Reset system database (destructive!)
npx dbos reset

# Debug: replay a workflow in debug mode
npx dbos debug <workflow-id>
```

---

## Version History

| Version | Key Changes |
|---|---|
| v2.0 (2025) | Major rewrite: lightweight, framework-agnostic, decorator + functional APIs, queueing |
| v3.0 (2025) | Removed deprecated v1 context APIs, removed built-in application database, datasource plugins |
| v4.0 (2025-2026) | Dramatically reduced package size (27→6 direct deps, 236→24 total), removed remaining deprecated APIs |

---

## Links

- **Docs:** https://docs.dbos.dev/typescript/programming-guide
- **GitHub:** https://github.com/dbos-inc/dbos-transact-ts
- **npm:** `@dbos-inc/dbos-sdk`
- **Discord:** https://discord.gg/fMwQjeW5zg
- **Architecture:** https://docs.dbos.dev/architecture
- **System Tables:** https://docs.dbos.dev/explanations/system-tables
- **Conductor:** https://docs.dbos.dev/production/conductor
