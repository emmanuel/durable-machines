# DBOS Transact TypeScript API Reference

## Table of Contents

1. [Lifecycle](#lifecycle)
2. [Workflows](#workflows)
3. [Steps](#steps)
4. [Queues](#queues)
5. [Messages (send/recv)](#messages-sendrecv)
6. [Events (setEvent/getEvent)](#events-seteventgetevent)
7. [Streams](#streams)
8. [Durable Utilities](#durable-utilities)
9. [Workflow Management](#workflow-management)
10. [Workflow Handles](#workflow-handles)
11. [Debouncing](#debouncing)
12. [Scheduled Workflows](#scheduled-workflows)
13. [Context Variables](#context-variables)
14. [DBOSClient (External Access)](#dbosclient-external-access)
15. [Configuration](#configuration)
16. [CLI Reference](#cli-reference)
17. [Instance Method Workflows](#instance-method-workflows)

---

## Lifecycle

### DBOS.setConfig()

```ts
DBOS.setConfig(config: DBOSConfig): void

interface DBOSConfig {
  name?: string;                      // Application name (required for Conductor)
  applicationVersion?: string;        // Code version for workflow versioning
  executorID?: string;                // Unique process ID (auto-set by Conductor)
  systemDatabaseUrl?: string;         // Postgres connection string
  systemDatabasePoolSize?: number;    // Connection pool size (min 5)
  systemDatabaseSchemaName?: string;  // Schema name (default: 'dbos')
  systemDatabasePool?: Pool;          // Provide your own pg Pool
  enableOTLP?: boolean;               // Enable OpenTelemetry
  logLevel?: string;                  // 'debug' | 'info' | 'warn' | 'error'
  otlpLogsEndpoints?: string[];       // OTLP log endpoints
  otlpTracesEndpoints?: string[];     // OTLP trace endpoints
  runAdminServer?: boolean;           // Run admin HTTP server (default: true)
  adminPort?: number;                 // Admin server port (default: 3001)
  listenQueues?: WorkflowQueue[];     // Only listen to these queues
  serializer?: DBOSSerializer;        // Custom serializer (default: JSON)
}
```

### DBOS.launch()

```ts
await DBOS.launch(options?: { conductorKey?: string; conductorURL?: string }): Promise<void>
```

Initializes database connections, creates system tables, recovers interrupted workflows, starts queue polling and scheduled workflows. Must be called after all registrations.

### DBOS.shutdown()

```ts
await DBOS.shutdown(options?: { deregister?: boolean }): Promise<void>
```

Terminates active workflows, closes connections. If `deregister: true`, clears all registrations (useful in tests for clean restarts).

### DBOS.logRegisteredEndpoints()

```ts
DBOS.logRegisteredEndpoints(): void
```

Logs all registered workflows, steps, scheduled workflows, and event receivers.

---

## Workflows

### Decorator: @DBOS.workflow()

```ts
@DBOS.workflow(config?: WorkflowConfig)

interface WorkflowConfig {
  name?: string;                // Workflow name (default: method name)
  maxRecoveryAttempts?: number; // Dead letter limit
}
```

```ts
export class MyService {
  @DBOS.workflow()
  static async myWorkflow(input: string): Promise<string> {
    const a = await MyService.stepA(input);
    const b = await MyService.stepB(a);
    return b;
  }
}

// Call normally
const result = await MyService.myWorkflow("hello");
```

### DBOS.registerWorkflow()

```ts
DBOS.registerWorkflow<This, Args extends unknown[], Return>(
  func: (this: This, ...args: Args) => Promise<Return>,
  config?: { name?: string } & WorkflowConfig,
): (this: This, ...args: Args) => Promise<Return>
```

```ts
async function myWorkflowFn(input: string): Promise<string> {
  const a = await stepA(input);
  return a;
}
const myWorkflow = DBOS.registerWorkflow(myWorkflowFn, { name: "myWorkflow" });

// Call normally
const result = await myWorkflow("hello");
```

### Workflow Guarantees

- **Always run to completion.** If interrupted, automatically resumed on restart.
- **Steps execute at least once, but never re-execute after completion.** Cached results are returned on replay.
- **Transactions commit exactly once** (when using datasource transactions).
- **Uncaught exceptions terminate the workflow.** Status → `ERROR`, no auto-recovery.
- **maxRecoveryAttempts** acts as a dead letter queue. Status → `RETRIES_EXCEEDED`.

---

## Steps

### Decorator: @DBOS.step()

```ts
@DBOS.step(config?: StepConfig)

interface StepConfig {
  retriesAllowed?: boolean;   // Enable retries (default: false)
  intervalSeconds?: number;   // Initial retry delay (default: 1)
  maxAttempts?: number;       // Max retries (default: 3)
  backoffRate?: number;       // Exponential backoff multiplier (default: 2)
  name?: string;              // Step name (default: method name)
}
```

```ts
export class MyService {
  @DBOS.step({ retriesAllowed: true, maxAttempts: 10 })
  static async callExternalAPI(input: string): Promise<ApiResponse> {
    const res = await fetch(`https://api.example.com/${input}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
```

### DBOS.registerStep()

```ts
const step = DBOS.registerStep(func, {
  name: "myStep",
  retriesAllowed: true,
  maxAttempts: 5,
  intervalSeconds: 2,
  backoffRate: 2,
});
```

### DBOS.runStep()

Run any function as an inline step within a workflow:

```ts
const result = await DBOS.runStep(
  () => someAsyncOperation(),
  { name: "myOperation", retriesAllowed: true, maxAttempts: 3 }
);
```

### Step Rules

- Steps can only be called from within workflows (or standalone, but without durability).
- Step return values must be JSON-serializable.
- You **cannot** call `DBOS.startWorkflow` from within a step.
- Calling a step from another step merges them into one checkpoint (no separate checkpoint for inner step).
- If all retries are exhausted, `DBOSMaxStepRetriesError` is thrown to the calling workflow.

---

## Queues

### WorkflowQueue

```ts
import { WorkflowQueue } from "@dbos-inc/dbos-sdk";

const queue = new WorkflowQueue("queue_name", {
  workerConcurrency?: number;           // Max concurrent per process
  concurrency?: number;                 // Max concurrent globally
  rateLimit?: {
    limitPerPeriod: number;             // Starts per period
    periodSec: number;                  // Period in seconds
  };
  priorityEnabled?: boolean;            // Enable priority ordering
  partitionQueue?: boolean;             // Enable per-partition flow control
});
```

Queues must be created before `DBOS.launch()`.

### Enqueue a Workflow

```ts
const handle = await DBOS.startWorkflow(myWorkflow, {
  queueName: "queue_name",
  enqueueOptions: {
    deduplicationID?: string;           // Prevent duplicate enqueue
    priority?: number;                  // Lower = higher priority (1 to 2^31-1)
    queuePartitionKey?: string;         // Partition key (for partitioned queues)
  },
})(arg1, arg2);
```

### Queue Behavior

- `DBOS.startWorkflow` with a `queueName` is durable — after it returns, execution is guaranteed.
- Workflow status: `ENQUEUED` → `PENDING` (when dequeued) → `SUCCESS`/`ERROR`.
- `workerConcurrency` requires unique `executorID` per process.
- Use `listenQueues` in config to restrict which queues a process dequeues from.
- To check stuck queues: `DBOS.listQueuedWorkflows()` or `npx dbos workflow queue list`.

---

## Messages (send/recv)

### DBOS.send()

```ts
DBOS.send<T>(
  destinationID: string,     // Target workflow ID
  message: T,                // Must be serializable
  topic?: string,            // Optional topic (separate queues per topic)
  idempotencyKey?: string,   // Prevent duplicate sends from outside workflows
): Promise<void>
```

### DBOS.recv()

```ts
DBOS.recv<T>(
  topic?: string,            // Topic to receive from
  timeoutSeconds?: number,   // Default: 60 seconds
): Promise<T | null>         // null on timeout
```

Can only be called from within a workflow. Blocks durably — survives restarts.

Messages are per-topic FIFO queues. Each `recv()` consumes one message.

---

## Events (setEvent/getEvent)

### DBOS.setEvent()

```ts
DBOS.setEvent<T>(key: string, value: T): Promise<void>
```

Publish a key-value pair from within a workflow. Overwrites previous value for the same key.

### DBOS.getEvent()

```ts
DBOS.getEvent<T>(
  workflowID: string,
  key: string,
  timeoutSeconds?: number,   // Default: 60 seconds
): Promise<T | null>         // null on timeout
```

Can be called from anywhere. Waits for the event to be set if it doesn't exist yet.

**Events vs Messages:** Events are last-write-wins (current state). Messages are FIFO queues (things that happened).

---

## Streams

### DBOS.writeStream()

```ts
DBOS.writeStream<T>(key: string, value: T): Promise<void>
```

Write a value to a named stream. Can be called from workflows or steps.

### DBOS.closeStream()

```ts
DBOS.closeStream(key: string): Promise<void>
```

Close a stream. No more values can be written. Can only be called from workflows.

### DBOS.readStream()

```ts
DBOS.readStream<T>(workflowID: string, key: string): AsyncGenerator<T, void, unknown>
```

Read values from a stream as an async generator. Yields each value in order until closed or workflow terminates.

```ts
for await (const value of DBOS.readStream(workflowID, "output")) {
  console.log(`Received: ${JSON.stringify(value)}`);
}
```

---

## Durable Utilities

### DBOS.sleep()

```ts
DBOS.sleep(durationMS: number): Promise<void>
```

Durable sleep — records wake-up time in DB. Survives restarts.

### DBOS.now()

```ts
DBOS.now(): Promise<number>
```

Checkpointed `Date.now()`. Use instead of `Date.now()` in workflows.

### DBOS.randomUUID()

```ts
DBOS.randomUUID(): Promise<string>
```

Checkpointed `crypto.randomUUID()`. Use instead of generating UUIDs directly in workflows.

---

## Workflow Management

### DBOS.startWorkflow()

```ts
DBOS.startWorkflow<Args, Return>(
  target: (...args: Args) => Promise<Return>,
  params?: StartWorkflowParams,
): (...args: Args) => Promise<WorkflowHandle<Return>>

interface StartWorkflowParams {
  workflowID?: string;        // Custom ID (idempotent)
  queueName?: string;         // Enqueue on this queue
  timeoutMS?: number | null;  // Workflow timeout
  enqueueOptions?: EnqueueOptions;
}
```

```ts
// Start in background
const handle = await DBOS.startWorkflow(myWorkflow)(arg1, arg2);

// With custom ID (idempotent)
const handle = await DBOS.startWorkflow(myWorkflow, {
  workflowID: `order-${orderId}`,
})(orderId);

// With queue
const handle = await DBOS.startWorkflow(myWorkflow, {
  queueName: "processing",
})(data);
```

### DBOS.retrieveWorkflow()

```ts
DBOS.retrieveWorkflow<T>(workflowID: string): WorkflowHandle<Awaited<T>>
```

Get a handle to an existing workflow by ID.

### DBOS.getWorkflowStatus()

```ts
DBOS.getWorkflowStatus(workflowID: string): Promise<WorkflowStatus | null>
```

### DBOS.listWorkflows()

```ts
DBOS.listWorkflows(input: GetWorkflowsInput): Promise<WorkflowStatus[]>

interface GetWorkflowsInput {
  workflowIDs?: string[];
  workflowName?: string | string[];
  status?: string | string[];    // ENQUEUED, PENDING, SUCCESS, ERROR, CANCELLED, MAX_RECOVERY_ATTEMPTS_EXCEEDED
  startTime?: string;            // RFC 3339
  endTime?: string;              // RFC 3339
  authenticatedUser?: string | string[];
  applicationVersion?: string | string[];
  executorId?: string | string[];
  queueName?: string | string[];
  parentWorkflowID?: string | string[];
  forkedFrom?: string | string[];
  limit?: number;
  offset?: number;
  sortDesc?: boolean;
  loadInput?: boolean;           // default true
  loadOutput?: boolean;          // default true
}
```

### DBOS.listWorkflowSteps()

```ts
DBOS.listWorkflowSteps(workflowID: string): Promise<StepInfo[] | undefined>

interface StepInfo {
  functionID: number;            // Sequential step ID (0-indexed)
  name: string;                  // Step name
  output: unknown;               // Step output (if completed)
  error: Error | null;           // Step error (if failed)
  childWorkflowID: string | null;
  startedAtEpochMs?: number;
  completedAtEpochMs?: number;
}
```

### DBOS.cancelWorkflow()

```ts
DBOS.cancelWorkflow(workflowID: string): Promise<void>
```

Sets status to `CANCELLED`, removes from queue, preempts execution at next step boundary.

### DBOS.resumeWorkflow()

```ts
DBOS.resumeWorkflow<T>(workflowID: string): Promise<WorkflowHandle<Awaited<T>>>
```

Resume from last completed step. Works for `CANCELLED` or `RETRIES_EXCEEDED` workflows. Also starts `ENQUEUED` workflows immediately, bypassing queues.

### DBOS.deleteWorkflow()

```ts
DBOS.deleteWorkflow(workflowID: string, deleteChildren?: boolean): Promise<void>
```

Permanently delete. Irreversible.

### DBOS.forkWorkflow()

```ts
DBOS.forkWorkflow<T>(
  workflowID: string,
  startStep: number,             // Step functionID to start from
  options?: {
    newWorkflowID?: string;
    applicationVersion?: string; // Run on a different code version
    timeoutMS?: number;
  },
): Promise<WorkflowHandle<Awaited<T>>>
```

Create a new workflow execution from a specific step. Useful for recovering from downstream outages or patching buggy steps.

---

## Workflow Handles

```ts
interface WorkflowHandle<R> {
  workflowID: string;
  getResult(): Promise<R>;              // Wait for completion
  getStatus(): Promise<WorkflowStatus | null>;
}
```

### WorkflowStatus

```ts
interface WorkflowStatus {
  workflowID: string;
  status: string;              // ENQUEUED | PENDING | SUCCESS | ERROR | CANCELLED | MAX_RECOVERY_ATTEMPTS_EXCEEDED
  workflowName: string;
  workflowClassName: string;
  input?: unknown[];
  output?: unknown;
  error?: unknown;
  executorId?: string;
  applicationVersion?: string;
  createdAt: number;           // Epoch ms
  updatedAt?: number;          // Epoch ms
  queueName?: string;
  parentWorkflowID?: string;
  forkedFrom?: string;
  timeoutMS?: number;
  priority: number;
  // ... and more
}
```

---

## Debouncing

```ts
import { Debouncer } from "@dbos-inc/dbos-sdk";

const debouncer = new Debouncer({
  workflow: processInput,
  debounceTimeoutMs: 300000,     // Max total delay: 5 minutes
});

// Each call resets the timer. Workflow runs 60s after LAST call.
// Uses the LAST set of arguments when it finally fires.
await debouncer.debounce(
  "user-123",                    // Debounce key (per-user, per-entity, etc.)
  60000,                         // Debounce period (ms)
  latestInput,                   // Workflow arguments
);
```

---

## Scheduled Workflows

### Decorator

```ts
@DBOS.workflow()
@DBOS.scheduled({ crontab: "*/30 * * * * *" })  // Every 30 seconds (6-field cron)
static async periodicCleanup(scheduledTime: Date, startTime: Date) {
  // scheduledTime: when this was supposed to run
  // startTime: when it actually started
}
```

### Functional

```ts
const cleanup = DBOS.registerWorkflow(cleanupFn);
DBOS.registerScheduled(cleanup, {
  crontab: "0 */5 * * *",           // Every 5 minutes (5-field cron)
  mode: SchedulerMode.ExactlyOncePerIntervalWhenActive, // or ExactlyOncePerInterval
  queueName: "maintenance",         // Optional: route through a queue
});
```

Cron supports 5-field (standard) or 6-field (with seconds):

```
 ┌────────────── second (optional)
 │ ┌──────────── minute
 │ │ ┌────────── hour
 │ │ │ ┌──────── day of month
 │ │ │ │ ┌────── month
 │ │ │ │ │ ┌──── day of week
 * * * * * *
```

---

## Context Variables

Available within workflows and steps:

| Variable | Type | Purpose |
|---|---|---|
| `DBOS.workflowID` | `string \| undefined` | Current workflow ID |
| `DBOS.stepID` | `number \| undefined` | Current step's sequential ID |
| `DBOS.stepStatus` | `StepStatus \| undefined` | Current retry attempt info |
| `DBOS.isInStep()` | `boolean` | Are we in a step? |
| `DBOS.isInTransaction()` | `boolean` | Are we in a datasource transaction? |
| `DBOS.executorID` | `string` | This process's executor ID |
| `DBOS.applicationVersion` | `string` | Current app version |
| `DBOS.logger` | `Logger` | Pre-configured Winston logger |
| `DBOS.span` | `Span \| undefined` | OpenTelemetry span |

---

## DBOSClient (External Access)

Connect to the DBOS system database from outside the DBOS runtime. Provides management and messaging without a running DBOS process.

```ts
import { DBOSClient } from "@dbos-inc/dbos-sdk";

const client = await DBOSClient.create({
  systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL!,
});

// Enqueue a workflow
const handle = await client.enqueue(
  { workflowName: "processOrder", queueName: "orders" },
  orderId,
);

// Type-safe enqueue
const handle = await client.enqueue<typeof OrderService.processOrder>(
  { workflowName: "processOrder", workflowClassName: "OrderService", queueName: "orders" },
  orderId,
);

// Send a message
await client.send(workflowId, { type: "APPROVE" }, "events");

// Read an event
const state = await client.getEvent(workflowId, "status");

// List, cancel, resume, fork — all available
const workflows = await client.listWorkflows({ status: "ERROR" });
await client.cancelWorkflow(workflowId);
await client.resumeWorkflow(workflowId);
await client.forkWorkflow(workflowId, 3);

await client.destroy();
```

**Use for:** webhook gateways, CLI tools, admin scripts, cross-service communication, external dashboards.

---

## Configuration

### Programmatic (required)

```ts
DBOS.setConfig({
  name: "my-app",
  systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL,
});
```

### dbos-config.yaml (for CLI tools and DBOS Cloud)

```yaml
name: my-app
language: node
system_database_url: ${DBOS_SYSTEM_DATABASE_URL}
runtimeConfig:
  start:
    - node dist/main.js
```

### Custom Serializer

```ts
const customSerializer: DBOSSerializer = {
  parse: (text) => {
    if (text === null || text === undefined) return null;
    return JSON.parse(Buffer.from(text, 'base64').toString());
  },
  stringify: (obj) => {
    if (obj === undefined) obj = null;
    return Buffer.from(JSON.stringify(obj)).toString('base64');
  },
};
config.serializer = customSerializer;
```

---

## CLI Reference

```bash
# Create system tables (privileged user)
npx dbos schema -s $DBOS_SYSTEM_DATABASE_URL

# List workflows
npx dbos workflow list [--status PENDING] [--limit 10] [--sort-desc]

# Get workflow steps
npx dbos workflow steps <workflow-id>

# Get workflow info
npx dbos workflow get <workflow-id>

# Cancel workflow
npx dbos workflow cancel <workflow-id>

# Resume workflow
npx dbos workflow resume <workflow-id>

# Restart workflow (new ID, same inputs)
npx dbos workflow restart <workflow-id>

# Fork workflow from step
npx dbos workflow fork <workflow-id> --start-step <step-id>

# List queued workflows
npx dbos workflow queue list [--queue-name <name>]

# Reset system database (destructive!)
npx dbos reset

# Debug replay
npx dbos debug <workflow-id>
```

---

## Instance Method Workflows

For workflows on class instances (e.g., with per-instance configuration):

```ts
import { ConfiguredInstance, DBOS } from "@dbos-inc/dbos-sdk";

class PaymentProcessor extends ConfiguredInstance {
  private apiKey: string;

  constructor(name: string, apiKey: string) {
    super(name);  // name must be unique per instance
    this.apiKey = apiKey;
  }

  @DBOS.workflow()
  async processPayment(amount: number): Promise<string> {
    return await this.chargeCard(amount);
  }

  @DBOS.step({ retriesAllowed: true })
  async chargeCard(amount: number): Promise<string> {
    // Use this.apiKey
    return "charge_123";
  }
}

// Must be instantiated before DBOS.launch()
const stripeProcessor = new PaymentProcessor("stripe", process.env.STRIPE_KEY!);
const paypalProcessor = new PaymentProcessor("paypal", process.env.PAYPAL_KEY!);
```

The `name` parameter uniquely identifies the instance for recovery. DBOS stores it in a global registry.
