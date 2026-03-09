# DBOS Backend Multi-Replica Clustering (Deferred Reference Design)

> **Status: DEFERRED** — Not implementing now. For multi-replica deployments,
> use the PG backend (row locks handle contention natively) or DBOS + Conductor.
> This document is a reference design for potential future implementation.

## Architectural Decision

| Replicas | Recommendation |
|----------|---------------|
| Single | DBOS or PG backend — both work |
| Multiple | **PG backend** (built-in row locks + LISTEN/NOTIFY) or DBOS + Conductor |

The PG backend handles multi-replica natively with zero additional code. The
DBOS backend's multi-replica story is handled by DBOS Conductor. Building our
own heartbeat/reaper would duplicate Conductor functionality for a narrow
audience.

## Context (if revisited)

The DBOS backend tags each workflow with the `executor_id` of the process that
started it. On restart, each executor only recovers *its own* PENDING workflows.
In a K8s Deployment with ephemeral pods, this creates orphans: pod-A starts a
workflow, pod-A dies, pod-B starts but doesn't recover pod-A's workflows.

DBOS Conductor solves this in hosted deployments. For self-hosted K8s
Deployments without Conductor, the design below provides the same coordination
with pure Postgres.

**Scope:** Worker package only. Gateway knows about PG directly but doesn't
need clustering. The PG backend doesn't need this — its row-level locks
(`FOR NO KEY UPDATE NOWAIT`) already handle multi-replica contention.

## Architecture

Workers use DBOS SDK (not PG directly). The cluster module lives in
`durable-machine/src/dbos/` and creates its own internal PG pool from the
system database URL. Workers discover each other through PG.

```
Worker Pod A                    Worker Pod B
┌─────────────────┐            ┌─────────────────┐
│  DBOS SDK       │            │  DBOS SDK       │
│  cluster module ├──┐    ┌────┤  cluster module │
└─────────────────┘  │    │    └─────────────────┘
                     ▼    ▼
              ┌──────────────────┐
              │  DBOS System DB  │
              │  (Postgres)      │
              │                  │
              │  xstate_dbos_executors (heartbeats)
              │  dbos.workflow_status  (ownership)
              └──────────────────┘
```

## Design

### Executor ID

Generated via `crypto.randomUUID()` at startup. Passed to
`DBOS.setConfig({ executorID })` before `DBOS.launch()`.

### Heartbeat Table

```sql
CREATE TABLE IF NOT EXISTS xstate_dbos_executors (
  executor_id    TEXT PRIMARY KEY,
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Two Background Loops

**Heartbeat** (default 5s):
```sql
INSERT INTO xstate_dbos_executors (executor_id, last_heartbeat, started_at)
VALUES ($1, NOW(), NOW())
ON CONFLICT (executor_id) DO UPDATE SET last_heartbeat = NOW()
```

**Reaper** (default 15s) — atomic CTE with advisory lock:
```sql
WITH reaper_lock AS (
  SELECT pg_try_advisory_xact_lock(hashtext('durable-xstate-reaper')) AS acquired
),
dead AS (
  DELETE FROM xstate_dbos_executors
  WHERE last_heartbeat < NOW() - INTERVAL '30 seconds'
    AND (SELECT acquired FROM reaper_lock)
  RETURNING executor_id
),
orphaned_executors AS (
  SELECT DISTINCT ws.executor_id
  FROM dbos.workflow_status ws
  WHERE ws.status = 'PENDING' AND ws.name LIKE 'xstate:%'
    AND ws.executor_id != $1
    AND NOT EXISTS (
      SELECT 1 FROM xstate_dbos_executors xe
      WHERE xe.executor_id = ws.executor_id
    )
)
UPDATE dbos.workflow_status
SET executor_id = $1
WHERE status = 'PENDING' AND name LIKE 'xstate:%'
  AND (
    executor_id IN (SELECT executor_id FROM dead)
    OR executor_id IN (SELECT executor_id FROM orphaned_executors)
  )
RETURNING workflow_uuid
```

After reassigning, call `DBOS.resumeWorkflow(workflowId)` for each claimed ID.

### Shutdown Sequence

1. Set `isShuttingDown` flag (readiness probe → 503)
2. Drain HTTP servers (close connections)
3. **`cluster.stop()`** — delete heartbeat row, stop loops (pool still alive)
4. `DBOS.shutdown()` — stop workflow processing
5. Close cluster pool
6. `process.exit(0)`

Deleting the heartbeat row before DBOS.shutdown() lets the reaper on other
replicas detect departure within one reaper cycle (~15s) instead of waiting for
the 30s dead threshold.

### Recovery Timing

| Scenario | Recovery Time |
|----------|---------------|
| Graceful shutdown (SIGTERM) | ≤15s (heartbeat deleted, reaper detects) |
| Hard crash (OOM, node failure) | ≤45s (30s dead threshold + 15s reaper) |

### Race Safety

`pg_try_advisory_xact_lock` is non-blocking — multiple reapers safe. DBOS's
step-level idempotency ensures only one checkpoint per step.

## Files to Create

### 1. `packages/durable-machine/src/dbos/cluster.ts` (~120 lines)

```ts
export interface ClusterOptions {
  /** DBOS system database connection string */
  systemDatabaseUrl: string;
  /** Heartbeat interval in ms (default: 5000) */
  heartbeatIntervalMs?: number;
  /** Reaper scan interval in ms (default: 15000) */
  reaperIntervalMs?: number;
  /** Dead threshold in ms (default: 30000) */
  deadThresholdMs?: number;
  /** Called when orphaned workflows are claimed */
  onReap?: (claimedWorkflowIds: string[]) => void;
}

export interface ClusterHandle {
  /** The executor ID for this cluster member */
  readonly executorId: string;
  /** Stop heartbeat + reaper loops, delete heartbeat row, close pool */
  stop(): Promise<void>;
}

export async function startCluster(options: ClusterOptions): Promise<ClusterHandle>;
```

Implementation:
- Creates own `pg.Pool` from `systemDatabaseUrl` (small pool, ~2 connections)
- Generates `executorId` via `crypto.randomUUID()`
- Creates table if not exists (idempotent)
- Inserts initial heartbeat
- Starts heartbeat interval + reaper interval
- `stop()`: clears intervals, deletes heartbeat row, ends pool

### 2. `packages/durable-machine/tests/integration/dbos/cluster.test.ts`

Tests:
- Table creation is idempotent
- Heartbeat UPSERT updates `last_heartbeat`
- Reaper claims workflows from dead executors
- Reaper ignores live executors
- `stop()` removes heartbeat row
- Advisory lock prevents concurrent reapers
- Orphaned executor detection (executor missing from table, has PENDING workflows)

## Files to Modify

### 3. `packages/durable-machine/src/dbos/shutdown.ts`

Add `cluster?: ClusterHandle` to `GracefulShutdownOptions`. In `shutdown()`,
after server drain and before `DBOS.shutdown()`:

```ts
if (options.cluster) {
  await options.cluster.stop();
}
```

### 4. `packages/durable-machine/src/dbos/index.ts`

Add exports:
```ts
export { startCluster } from "./cluster.js";
export type { ClusterOptions, ClusterHandle } from "./cluster.js";
```

### 5. `packages/worker/src/lifecycle.ts`

**`parseDBOSWorkerConfig()`** — add cluster env vars:

| Env Var | Default | Description |
|---------|---------|-------------|
| `CLUSTER_DATABASE_URL` | *(none)* | Enables cluster when set |
| `CLUSTER_HEARTBEAT_INTERVAL_MS` | 5000 | Heartbeat frequency |
| `CLUSTER_REAPER_INTERVAL_MS` | 15000 | Reaper scan frequency |
| `CLUSTER_DEAD_THRESHOLD_MS` | 30000 | Dead executor threshold |

**`DBOSWorkerConfig`** — add nested cluster sub-object:
```ts
export interface DBOSWorkerConfig {
  adminPort?: number;
  shutdownTimeoutMs: number;
  cluster?: {
    systemDatabaseUrl: string;
    heartbeatIntervalMs: number;   // default 5000
    reaperIntervalMs: number;      // default 15000
    deadThresholdMs: number;       // default 30000
  };
}
```

Cluster config is present only when `CLUSTER_DATABASE_URL` is set. All
sub-fields get defaults from the Zod schema.

**`DBOSWorkerContext`** — add optional cluster handle:
```ts
cluster?: ClusterHandle;
```

**`createDBOSWorkerContext()`** — when `config.cluster` is set:
1. `const cluster = await startCluster(config.cluster)`
2. `DBOS.setConfig({ executorID: cluster.executorId })`
3. (then existing: register machines, DBOS.launch())
4. Store `cluster` in returned context

**`startDBOSWorker()`** — pass cluster to gracefulShutdown:
```ts
const shutdown = gracefulShutdown({
  servers,
  timeoutMs: ctx.config.shutdownTimeoutMs,
  cluster: ctx.cluster,
});
```

### 6. `packages/worker/src/index.ts`

Re-export `ClusterHandle` type (for users who need to reference it).

### 7. `packages/worker/README.md`

Add multi-replica section documenting env vars and deployment pattern.

## Non-changes

- **Gateway** (`packages/gateway/`) — no changes (PG backend, not DBOS)
- **PG backend** (`durable-machine/src/pg/`) — row locks handle contention
- **`create-durable-machine.ts`** — unchanged (DBOS.setConfig sets executorID)
- **`machine-loop.ts`** — unchanged (loop logic is executor-agnostic)

## Usage

### Single replica (no cluster, existing behavior)

```ts
const config = parseDBOSWorkerConfig();
const ctx = await createDBOSWorkerContext(config, { machines: { ... } });
startDBOSWorker(ctx);
```

### Multi-replica (cluster enabled via env)

```bash
# K8s Deployment env
CLUSTER_DATABASE_URL=postgresql://...
ADMIN_PORT=9090
```

```ts
// Same code — cluster is activated automatically when CLUSTER_DATABASE_URL is set
const config = parseDBOSWorkerConfig();
// config.cluster → { systemDatabaseUrl: "postgresql://...", heartbeatIntervalMs: 5000, ... }
const ctx = await createDBOSWorkerContext(config, { machines: { ... } });
startDBOSWorker(ctx);
// ctx.cluster.executorId → "a1b2c3d4-..."
```

## Verification

```bash
# Typecheck
pnpm --filter durable-machine typecheck
pnpm --filter worker typecheck

# Unit + integration tests
pnpm --filter durable-machine test
pnpm --filter worker test

# Specific cluster tests
pnpm --filter durable-machine test -- tests/integration/dbos/cluster
```
