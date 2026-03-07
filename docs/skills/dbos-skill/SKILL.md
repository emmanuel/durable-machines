---
name: dbos
description: Use this skill whenever the user wants to build durable, crash-proof TypeScript applications using DBOS Transact. This includes creating durable workflows with checkpointed steps, adding reliability to existing Node.js/Express/Next.js apps, using DBOS queues for background tasks with concurrency and rate control, scheduling workflows with cron, sending/receiving inter-workflow messages, building human-in-the-loop approval flows, managing long-running processes, recovering from failures, using DBOSClient for cross-service communication, running exactly-once database transactions via datasource plugins, connecting to DBOS Conductor for production observability and distributed recovery, persisting workflow state in Postgres, upgrading workflow code safely with patching or versioning, or debugging workflow step history. Trigger this skill even for tangential mentions — if the user says "durable execution," "DBOS," "workflow checkpoint," "crash-proof," "resilient workflow," "Postgres-backed workflow," "step recovery," "exactly-once," "workflow orchestration with Postgres," or discusses making TypeScript code survive crashes and restarts, use this skill.
---

# DBOS Transact TypeScript Skill

DBOS Transact is an open-source durable execution library for TypeScript. It checkpoints workflow and step state to Postgres so that if a program crashes or is interrupted, workflows automatically resume from the last completed step on restart. No external orchestration server — just your code and Postgres.

**Reference files** (read as needed — do NOT load all at once):
- `references/api-reference.md` — Full API: workflows, steps, queues, events, messages, streams, lifecycle, configuration, DBOSClient, CLI
- `references/patterns.md` — Common recipes: background tasks, approval flows, fan-out/fan-in, idempotent starts, scheduled jobs, retry, saga, data pipelines
- `references/production.md` — Conductor, distributed deployment, upgrading workflows (patching/versioning/forking), system tables, monitoring, production checklist
- `references/datasources.md` — Exactly-once transactions with Knex, Drizzle, Prisma, TypeORM datasource plugins

## When to Read References

| User wants to... | Read |
|---|---|
| Build a workflow from scratch | This file (continue below) |
| Use a specific API (send/recv, queues, startWorkflow, etc.) | `references/api-reference.md` |
| See a pattern (approval, saga, fan-out, pipeline) | `references/patterns.md` |
| Deploy to production, use Conductor, upgrade workflow code | `references/production.md` |
| Use exactly-once database transactions | `references/datasources.md` |

---

## Installation

```bash
npm install @dbos-inc/dbos-sdk
```

Requires **Node.js 20+** and a **Postgres database** (the "system database").

**Bundler warning:** DBOS **cannot** be bundled with Webpack, Vite, Rollup, esbuild, or Parcel. It must be treated as an external dependency. This is because DBOS's internal workflow registry relies on runtime function identity.

Start Postgres via Docker if needed:

```bash
docker run --name dbos-postgres -e POSTGRES_PASSWORD=dbos -p 5432:5432 -d postgres:16
export DBOS_SYSTEM_DATABASE_URL=postgresql://postgres:dbos@localhost:5432/dbos_system
```

---

## Essential Mental Model

1. **Workflows** are functions whose execution state is checkpointed to Postgres. If the process crashes, workflows resume from the last completed step on restart.
2. **Steps** are units of work within a workflow whose return values are cached in Postgres. Once a step completes, it is never re-executed — on recovery, the cached result is returned.
3. **Workflow functions must be deterministic.** Given the same inputs and step return values, they must invoke the same steps in the same order. All non-determinism (API calls, DB access, random numbers, time) must be inside steps.
4. **Inputs and outputs must be JSON-serializable** (or use a custom serializer). This includes workflow inputs, workflow outputs, and step return values.
5. **Uncaught exceptions terminate workflows.** The workflow is marked `ERROR` and is NOT automatically recovered. Transient failures should be handled with step-level retries.
6. **Recovery is replay-based.** On restart, the workflow re-executes from the beginning. Each step checks Postgres for a cached result. If found, the cached result is returned instantly. Once a step with no cached result is reached, normal execution resumes.

---

## The Standard Workflow Template

Three equivalent registration styles. Use whichever fits your codebase.

### Style 1: Decorators (Class-Based)

```ts
import { DBOS } from "@dbos-inc/dbos-sdk";

export class OrderService {
  @DBOS.workflow()
  static async processOrder(orderId: string): Promise<string> {
    const chargeId = await OrderService.chargePayment(orderId);
    await OrderService.sendConfirmation(orderId, chargeId);
    return chargeId;
  }

  @DBOS.step({ retriesAllowed: true, maxAttempts: 5, intervalSeconds: 2, backoffRate: 2 })
  static async chargePayment(orderId: string): Promise<string> {
    const res = await fetch(`https://payments.example.com/charge/${orderId}`, { method: 'POST' });
    if (!res.ok) throw new Error(`Payment failed: ${res.status}`);
    return (await res.json()).chargeId;
  }

  @DBOS.step()
  static async sendConfirmation(orderId: string, chargeId: string): Promise<void> {
    await fetch('https://email.example.com/send', {
      method: 'POST',
      body: JSON.stringify({ orderId, chargeId, template: 'order-confirm' }),
    });
  }
}
```

### Style 2: registerWorkflow / registerStep (Functional)

```ts
import { DBOS } from "@dbos-inc/dbos-sdk";

async function chargePaymentFn(orderId: string): Promise<string> {
  const res = await fetch(`https://payments.example.com/charge/${orderId}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Payment failed`);
  return (await res.json()).chargeId;
}
const chargePayment = DBOS.registerStep(chargePaymentFn, {
  name: "chargePayment",
  retriesAllowed: true,
  maxAttempts: 5,
});

async function processOrderFn(orderId: string): Promise<string> {
  const chargeId = await chargePayment(orderId);
  return chargeId;
}
const processOrder = DBOS.registerWorkflow(processOrderFn, { name: "processOrder" });
```

### Style 3: Inline DBOS.runStep

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
- **Decorators**: Class-based organization, cleanest syntax.
- **registerWorkflow/registerStep**: Standalone functions, dynamic registration.
- **DBOS.runStep**: Inline/ad-hoc operations, quick prototyping.

All three are equivalent at runtime. Mix freely in the same app.

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
  // logLevel: "info",
});

// 2. Register workflows, steps, queues, scheduled functions, datasources
//    (decorators auto-register when classes are imported)

// 3. Launch
await DBOS.launch();
// Connects to Postgres, creates system tables, recovers PENDING workflows,
// starts queue polling and scheduled workflows.

// 4. Run your app (Express, Next.js, standalone, etc.)

// 5. Shutdown
await DBOS.shutdown();
```

**Critical:** All registrations must happen BEFORE `DBOS.launch()`. DBOS builds its registry at launch time.

---

## Key Concepts Cheatsheet

### Step Configuration

```ts
interface StepConfig {
  retriesAllowed?: boolean;   // Enable retries on exception (default: false)
  intervalSeconds?: number;   // Initial retry delay (default: 1)
  maxAttempts?: number;       // Max retry count (default: 3)
  backoffRate?: number;       // Multiply interval between retries (default: 2)
  name?: string;              // Step name (used in logging, recovery, UI)
}
```

**Always name your steps** — names appear in Conductor UI, CLI output, and step history.

### Queues

```ts
import { DBOS, WorkflowQueue } from "@dbos-inc/dbos-sdk";

const queue = new WorkflowQueue("processing", {
  workerConcurrency: 5,         // Max concurrent per process
  concurrency: 20,              // Max concurrent globally
  rateLimit: { limitPerPeriod: 100, periodSec: 60 },
  priorityEnabled: true,
});

// Enqueue a workflow
const handle = await DBOS.startWorkflow(processOrder, {
  queueName: queue.name,
  enqueueOptions: { priority: 1, deduplicationID: `order-${id}` },
})(orderId);
```

### Messages (send/recv)

```ts
// Sender (from anywhere)
await DBOS.send(targetWorkflowId, { type: "APPROVE" }, "approvals");

// Receiver (inside target workflow — blocks until message or timeout)
const msg = await DBOS.recv<{ type: string }>("approvals", 3600); // 1 hour timeout
// Returns null on timeout
```

### Events (setEvent/getEvent)

```ts
// Publisher (inside workflow)
await DBOS.setEvent("status", { progress: 75 });

// Consumer (from anywhere — waits for value or timeout)
const status = await DBOS.getEvent(workflowId, "status", 30);
```

Events are last-write-wins (latest value). Messages are FIFO queues.

### Durable Utilities

```ts
await DBOS.sleep(5000);         // Durable sleep — survives restarts
const now = await DBOS.now();   // Checkpointed Date.now()
const id = await DBOS.randomUUID(); // Checkpointed UUID
```

### Background Workflows

```ts
const handle = await DBOS.startWorkflow(processOrder, {
  workflowID: `order-${orderId}`,  // Custom ID (idempotent)
})(orderId);

// Poll status
const status = await handle.getStatus();
// Wait for result
const result = await handle.getResult();
```

---

## Determinism Rules

Workflow functions MUST be deterministic on replay. These are UNSAFE directly in a workflow:

| Unsafe in Workflow | Safe Alternative |
|---|---|
| `Date.now()` | `await DBOS.now()` |
| `Math.random()` | Wrap in `DBOS.runStep` |
| `crypto.randomUUID()` | `await DBOS.randomUUID()` |
| `fetch()` / HTTP calls | Wrap in `DBOS.runStep` or `@DBOS.step()` |
| Database queries | Use `@DBOS.step()` or datasource transaction |
| File I/O | Wrap in `DBOS.runStep` |

**Safe directly in a workflow:** branching on step return values, loops, string manipulation, JSON operations, pure computation, calling other registered steps.

---

## Critical Gotchas

1. **Uncaught exceptions = dead workflow.** Status becomes `ERROR`, no auto-recovery. Wrap transient failures in steps with retries. Catch and handle non-transient errors explicitly.

2. **Step nesting is flattened.** Calling a step from another step does NOT create a separate checkpoint — the inner step becomes part of the outer step.

3. **Cannot start workflows from steps.** `DBOS.startWorkflow` can only be called from workflow functions or from outside DBOS.

4. **recv() default timeout is 60 seconds.** For long-running approvals, always specify an explicit timeout.

5. **Workflow ID reuse is idempotent.** Starting a workflow with an existing ID returns the existing execution (or its completed result). This is by design, but can be surprising.

6. **PgBouncer requires session mode.** Transaction mode breaks DBOS's multi-statement patterns.

7. **Max recovery attempts.** Set `maxRecoveryAttempts` on workflows that might crash the process (e.g., OOM) to prevent infinite recovery loops.

8. **All registrations before launch.** Workflows, steps, queues, datasources, ConfiguredInstance subclasses — all must be registered before `DBOS.launch()`.

9. **Name your steps.** Unnamed `DBOS.runStep` calls get auto-generated names that may not be stable across code changes, breaking recovery.

10. **Serialization limits.** Each workflow input, output, and step output is stored as Postgres TEXT (max 1GB). Keep payloads reasonable.

---

## When Generating DBOS Code

Follow this workflow:

1. **Identify the workflow.** What is the end-to-end process that must be reliable?
2. **Identify the steps.** What are the individual operations (API calls, DB writes, emails)?
3. **Configure retries.** Which steps might transiently fail? Set `retriesAllowed`, `maxAttempts`, `backoffRate`.
4. **Decide on queues.** Do you need concurrency control, rate limiting, or background execution?
5. **Decide on messaging.** Does the workflow need to wait for external input? Use `recv()`. Does it need to publish status? Use `setEvent()`.
6. **Use `setup()` pattern.** Configure DBOS, register all workflows/steps, then launch.
7. **Name everything.** Give explicit names to workflows and steps.
8. **Set input types.** Ensure all workflow args and step return values are JSON-serializable.
9. **Handle errors.** Wrap transient failures in steps with retries. Let non-recoverable errors terminate the workflow explicitly.
10. **Add Conductor for production.** Pass `conductorKey` to `DBOS.launch()` for distributed recovery and observability.
