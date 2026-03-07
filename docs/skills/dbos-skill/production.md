# DBOS Production Guide

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [System Database & Tables](#system-database--tables)
3. [Recovery Model](#recovery-model)
4. [DBOS Conductor](#dbos-conductor)
5. [Distributed Deployment](#distributed-deployment)
6. [Upgrading Workflow Code](#upgrading-workflow-code)
7. [Monitoring & Observability](#monitoring--observability)
8. [Production Checklist](#production-checklist)

---

## Architecture Overview

DBOS is implemented entirely in the open-source library — no external orchestration server. The only dependency is a Postgres database (the "system database") that stores all workflow checkpoints, step outputs, and queue state.

```
┌──────────────────┐     ┌──────────────────┐
│  Your App + DBOS │     │  Your App + DBOS │
│  (Process 1)     │     │  (Process 2)     │
│  executorID: a1  │     │  executorID: a2  │
└────────┬─────────┘     └────────┬─────────┘
         │                        │
         └────────┬───────────────┘
                  │
         ┌────────▼─────────┐
         │   Postgres        │
         │   System Database │
         │   (dbos schema)   │
         └──────────────────┘
                  │
         ┌────────▼─────────┐
         │   Conductor       │  ← optional, for distributed recovery
         │   (WebSocket)     │     and observability
         └──────────────────┘
```

**Key properties:**
- No orchestration server on the critical path.
- All state in Postgres — queryable with standard tools.
- Multiple processes connect to the same system database.
- Each process has a unique `executorID`.
- One physical Postgres server can host multiple system databases for different applications.

**DB overhead per workflow:**
- 1 write at start (inputs)
- 1 write per step (output)
- 1 write at end (final status)
- Write sizes are proportional to input/output sizes.

---

## System Database & Tables

All tables are in the `dbos` schema. Accessible at `dbos.workflow_status`, `dbos.operation_outputs`, etc.

### dbos.workflow_status

One row per workflow execution.

| Column | Description |
|---|---|
| `workflow_uuid` | Unique workflow ID |
| `status` | `PENDING`, `SUCCESS`, `ERROR`, `ENQUEUED`, `CANCELLED`, `MAX_RECOVERY_ATTEMPTS_EXCEEDED` |
| `name` | Workflow function name |
| `class_name` | Workflow class name (if decorator) |
| `inputs` | Serialized workflow inputs |
| `output` | Serialized workflow output |
| `error` | Serialized error |
| `created_at` | Creation timestamp (epoch) |
| `updated_at` | Last status update timestamp |
| `executor_id` | Process that ran this workflow |
| `application_version` | Code version |
| `queue_name` | Queue name (if enqueued) |
| `recovery_attempts` | Count of recovery attempts |
| `parent_workflow_id` | Parent workflow ID (if child) |
| `forked_from` | Source workflow ID (if forked) |
| `priority` | Queue priority |
| `deduplication_id` | Queue dedup key |
| `workflow_timeout_ms` | Timeout setting |
| `workflow_deadline_epoch_ms` | Computed deadline |
| `started_at_epoch_ms` | Dequeue time (for queued workflows) |

### dbos.operation_outputs

One row per step execution.

| Column | Description |
|---|---|
| `workflow_uuid` | Parent workflow ID |
| `function_id` | Sequential step ID (0-indexed) |
| `function_name` | Step name |
| `output` | Serialized step output |
| `error` | Serialized step error |
| `child_workflow_id` | If this step starts a child workflow |
| `started_at_epoch_ms` | Step start time |
| `completed_at_epoch_ms` | Step completion time |

### Other Tables

| Table | Purpose |
|---|---|
| `dbos.notifications` | Durable messages (`send`/`recv`) |
| `dbos.workflow_events` | Published events (`setEvent`) — current values |
| `dbos.workflow_events_history` | Historical event values with step IDs |
| `dbos.streams` | Stream messages with offsets |
| `dbos.workflow_schedules` | Cron schedule definitions |

You can query these tables directly with `psql`, DBeaver, or any Postgres client for debugging, reporting, or custom dashboards.

---

## Recovery Model

### How Recovery Works

1. On startup, DBOS scans for workflows with status `PENDING` belonging to this executor.
2. For each, it calls the workflow function with the original checkpointed inputs.
3. As the workflow re-executes, each step checks `dbos.operation_outputs` for a cached result.
4. If a checkpoint exists → return cached output instantly (no re-execution).
5. If no checkpoint → this is where the original execution failed. Execute normally and checkpoint.
6. The workflow continues forward from this point.

**Recovery is replay-based, not snapshot-based.** The workflow function runs from the beginning every time. This is why determinism is critical.

### Concurrent Recovery

If two processes try to recover the same workflow:
- The first to complete each step writes the checkpoint.
- The second sees the checkpoint exists and returns the cached result.
- Both converge to the same outcome.

### Dead Letter Queue

Set `maxRecoveryAttempts` to prevent infinite recovery loops:

```ts
@DBOS.workflow({ maxRecoveryAttempts: 5 })
static async riskyWorkflow() { /* ... */ }
```

After 5 failed recovery attempts, status → `MAX_RECOVERY_ATTEMPTS_EXCEEDED`. Use `DBOS.resumeWorkflow()` to manually retry.

---

## DBOS Conductor

Conductor is a management service (hosted or self-hosted) that provides:

- **Distributed recovery:** Detects executor failures via WebSocket, reassigns workflows to healthy executors.
- **Observability:** Dashboards for workflows, queues, step history, execution graphs.
- **Management:** Pause, resume, cancel, fork workflows from a web UI.
- **Retention policies:** Manage workflow history retention.
- **Alerting:** Workflow failure alerts, slow queue alerts, unresponsive app alerts.

### Connecting to Conductor

```ts
// 1. Register your app on https://console.dbos.dev
// 2. Generate an API key
// 3. Pass it to launch:
DBOS.setConfig({
  name: "my-app",  // Must match registered name
  systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL,
});
await DBOS.launch({ conductorKey: process.env.DBOS_CONDUCTOR_KEY });
```

### Architecture

- Your app opens an outbound WebSocket connection to Conductor.
- Conductor never accesses your database directly.
- Conductor is out-of-band and off the critical path.
- If Conductor goes down, your app continues running normally.
- Failed workflow recovery resumes when the connection is restored.

### Self-Hosting Conductor

Conductor can be self-hosted via Docker Compose (dev) or Kubernetes (production). Self-hosting for commercial use requires a license key.

```yaml
# docker-compose.yml (development)
services:
  conductor:
    image: dbos/conductor:latest
    ports:
      - "8090:8090"
    environment:
      DBOS__CONDUCTOR_DB_URL: postgresql://...  # Conductor's own database
  console:
    image: dbos/console:latest
    ports:
      - "80:80"
    environment:
      DBOS_CONDUCTOR_URL: http://conductor:8090
```

For production, place both behind a reverse proxy with TLS. Configure OAuth SSO for authentication.

### Alert Handler

```ts
DBOS.setAlertHandler(async (ruleType, message, metadata) => {
  // ruleType: 'WorkflowFailure' | 'SlowQueue' | 'UnresponsiveApplication'
  console.log(`Alert [${ruleType}]: ${message}`, metadata);
  await sendToSlack(message);
});
// Must be registered before DBOS.launch()
```

---

## Distributed Deployment

### Multiple Processes

Deploy your DBOS app to multiple processes (Kubernetes pods, EC2 instances, Cloud Run instances). All connect to the same system database.

**Requirements:**
- Each process must have a unique `executorID` (set automatically by Conductor; set manually otherwise).
- All processes must run compatible code (same workflow/step names and registration order).

### Heterogeneous Workers

Use `listenQueues` to direct specific work to specific workers:

```ts
const cpuQueue = new WorkflowQueue("cpu_tasks");
const gpuQueue = new WorkflowQueue("gpu_tasks");

const workerType = process.env.WORKER_TYPE; // "cpu" or "gpu"
DBOS.setConfig({
  name: "my-app",
  systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL,
  listenQueues: workerType === "gpu" ? [gpuQueue] : [cpuQueue],
});
```

### Separate Worker Services

Deploy queue workers as a separate application with their own system database. Use DBOSClient from your API server to enqueue work:

```ts
// API server (no DBOS runtime, just client)
const workerClient = await DBOSClient.create({
  systemDatabaseUrl: process.env.WORKER_SYSTEM_DB_URL!,
});
await workerClient.enqueue({ workflowName: "processJob", queueName: "jobs" }, jobData);
```

### Without Conductor

For single-node deployments, DBOS auto-recovers all `PENDING` workflows at startup.

For multi-node without Conductor, you need a custom reaper:
1. Monitor `dbos.workflow_status` for stale `PENDING` workflows (check `executor_id` liveness).
2. Call `DBOS.resumeWorkflow()` from a healthy process.

---

## Upgrading Workflow Code

A **breaking change** is one that changes which steps run or their order. On recovery, checkpoints won't match the new code.

### Strategy 1: Patching

Use `DBOS.patch()` to conditionally run new code:

```ts
async function myWorkflowFn() {
  if (await DBOS.patch("add-validation")) {
    // New code: runs for workflows started AFTER the patch
    await DBOS.runStep(() => validate(), { name: "validate" });
  }
  // Original code continues
  await DBOS.runStep(() => process(), { name: "process" });
}
```

- `DBOS.patch()` returns `true` for new workflows, `false` for in-flight old ones.
- Once all old workflows complete, deprecate with `DBOS.deprecatePatch()`.
- Once all deprecated workflows complete, remove the patch entirely.

**Lifecycle:**

```
v1: await process()
v2: if (patch("add-validation")) { await validate(); }   await process()
v3: if (deprecatePatch("add-validation")) { await validate(); }  await process()
v4: await validate()   await process()
```

### Strategy 2: Versioning

Tag deployments with `applicationVersion`. DBOS only recovers workflows matching the current version.

```ts
DBOS.setConfig({
  name: "my-app",
  applicationVersion: "2.0.0",
  systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL,
});
```

Deploy new code with a new version. Keep old instances running to drain old workflows. By default, version is auto-computed from a hash of workflow source code.

### Strategy 3: Forking

Restart a failed workflow from a specific step on a new code version:

```ts
const handle = await DBOS.forkWorkflow(failedWorkflowId, failedStepId, {
  applicationVersion: "2.0.1",
});
```

Useful for recovering from downstream outages or patching bugs in production.

### Detecting Mismatches

If a breaking change isn't properly patched, the workflow throws `DBOSUnexpectedStepError` pointing to the mismatched step.

---

## Monitoring & Observability

### OpenTelemetry

```ts
DBOS.setConfig({
  enableOTLP: true,
  otlpTracesEndpoints: ["http://otel-collector:4318/v1/traces"],
  otlpLogsEndpoints: ["http://otel-collector:4318/v1/logs"],
});
```

Each workflow and step generates spans with attributes for workflow ID, step ID, status, etc.

### Querying System Tables

```sql
-- Find errored workflows in the last hour
SELECT workflow_uuid, name, error, created_at
FROM dbos.workflow_status
WHERE status = 'ERROR'
  AND created_at > EXTRACT(EPOCH FROM NOW() - INTERVAL '1 hour') * 1000;

-- Find slow steps
SELECT workflow_uuid, function_name,
       completed_at_epoch_ms - started_at_epoch_ms AS duration_ms
FROM dbos.operation_outputs
WHERE completed_at_epoch_ms - started_at_epoch_ms > 10000
ORDER BY duration_ms DESC;

-- Queue depth
SELECT queue_name, COUNT(*) as depth
FROM dbos.workflow_status
WHERE status = 'ENQUEUED'
GROUP BY queue_name;
```

### CLI Monitoring

```bash
npx dbos workflow list --status ERROR --limit 20
npx dbos workflow steps <workflow-id>
npx dbos workflow queue list
```

---

## Production Checklist

1. **Postgres:** Production-grade instance (RDS, CloudSQL, Supabase, Neon, CockroachDB). Min pool size 5.
2. **Connection pooler:** If using PgBouncer, **session mode only** (not transaction mode).
3. **Conductor:** Connect for distributed recovery and observability.
4. **Executor ID:** Unique per process. Auto-set by Conductor; set manually otherwise.
5. **Application version:** Set explicitly for reproducible deployments and safe upgrades.
6. **Schema migration:** In restricted envs, run `npx dbos schema` with privileged user, then run app with minimum permissions.
7. **Serialization:** All workflow inputs, outputs, and step outputs must be JSON-serializable.
8. **Step naming:** Always provide explicit `name` values for `DBOS.runStep()` calls.
9. **Max recovery attempts:** Set on workflows that might crash the process to prevent infinite loops.
10. **Bundler exclusion:** Mark `@dbos-inc/dbos-sdk` as external in any bundler config.
11. **Retention:** Configure workflow history retention in Conductor to prevent unbounded table growth.
12. **Observability:** Enable OTLP export for traces and logs.
13. **Health checks:** Monitor `dbos.workflow_status` for `ERROR` and `MAX_RECOVERY_ATTEMPTS_EXCEEDED` workflows.
14. **Backups:** Standard Postgres backup strategy covers all DBOS state.
15. **Connection limits:** Size `systemDatabasePoolSize` to your connection limit / number of processes.
