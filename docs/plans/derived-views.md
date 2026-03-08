# Plan: Derived Views from Transition Log

## Status: Planned

Prerequisite: none (PG backend only). Builds on the existing `transition_log`
table. Enhanced by the append-only event log plan (richer source data).

## Problem

The `transition_log` table records every state transition with `from_state`,
`to_state`, `event`, and `ts`. The visualization module already derives
`StateDuration[]` from this log on every read via `computeStateDurations()`.
This works fine for single-instance inspection, but falls apart for:

1. **Dashboards** — "Average time orders spend in `pending`" requires scanning
   every instance's transition log, computing durations, and aggregating. This is
   O(instances * transitions) on every dashboard load.
2. **Alerting** — "Alert when any instance has been in `pending` for > 1 hour"
   requires polling every active instance.
3. **Analytics** — "What percentage of orders get cancelled vs. delivered?" is a
   full table scan with application-level aggregation.
4. **Bottleneck detection** — "Which state has the longest average dwell time?"
   requires the same expensive computation.

The transition log has all the data. The problem is that we re-derive the same
views on every read instead of materializing them.

## Core Insight

The transition log is an event-sourced append-only record. Views derived from it
can be materialized incrementally: each new transition log entry updates the
relevant materialized rows. This is the same pattern as Rama's PStates — indexed
views maintained by topologies that process depot events.

In PG, this means triggers or application-level write-path updates that maintain
summary tables alongside transition log inserts.

## Proposed Views

### 1. `state_durations` — materialized time-in-state

Replaces the on-read `computeStateDurations()` with a persisted table updated on
each transition.

```sql
CREATE TABLE IF NOT EXISTS state_durations (
  instance_id     TEXT NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  state_value     JSONB NOT NULL,
  entered_at      BIGINT NOT NULL,
  exited_at       BIGINT,
  duration_ms     BIGINT,
  PRIMARY KEY (instance_id, entered_at)
);

CREATE INDEX IF NOT EXISTS idx_sd_state
  ON state_durations (state_value, instance_id);
```

**Write path**: When a transition is logged, the event processor:
1. Closes the previous duration row: `SET exited_at = ts, duration_ms = ts - entered_at`
2. Opens a new duration row: `INSERT (instance_id, state_value, entered_at)`

Both happen in the same transaction as the state update.

**Read path**: Dashboard queries become simple SQL:

```sql
-- Average time in each state for a machine
SELECT state_value, AVG(duration_ms) as avg_ms, COUNT(*) as n
FROM state_durations sd
JOIN machine_instances mi ON sd.instance_id = mi.id
WHERE mi.machine_name = 'order'
  AND sd.exited_at IS NOT NULL
GROUP BY state_value;

-- Instances stuck in a state for > 1 hour
SELECT instance_id, state_value, entered_at
FROM state_durations
WHERE exited_at IS NULL
  AND entered_at < $now - 3600000;
```

### 2. `transition_counts` — aggregate transition frequency

```sql
CREATE TABLE IF NOT EXISTS transition_counts (
  machine_name    TEXT NOT NULL,
  from_state      JSONB,
  to_state        JSONB NOT NULL,
  event           TEXT,
  count           BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (machine_name, from_state, to_state, event)
);
```

**Write path**: `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1` on each
transition log entry.

**Read path**:

```sql
-- Transition heatmap for a machine
SELECT from_state, to_state, event, count
FROM transition_counts
WHERE machine_name = 'order'
ORDER BY count DESC;

-- Cancel rate
SELECT
  (SELECT count FROM transition_counts
   WHERE machine_name = 'order' AND to_state = '"cancelled"') AS cancelled,
  (SELECT SUM(count) FROM transition_counts
   WHERE machine_name = 'order' AND from_state IS NULL) AS total;
```

### 3. `instance_summary` — per-instance lifecycle metrics

```sql
CREATE TABLE IF NOT EXISTS instance_summary (
  instance_id     TEXT PRIMARY KEY REFERENCES machine_instances(id) ON DELETE CASCADE,
  machine_name    TEXT NOT NULL,
  started_at      BIGINT NOT NULL,
  completed_at    BIGINT,
  total_transitions INTEGER NOT NULL DEFAULT 0,
  final_state     JSONB
);
```

**Write path**: Updated on each transition (increment `total_transitions`) and on
completion (set `completed_at`, `final_state`).

**Read path**:

```sql
-- Average instance lifetime by machine
SELECT machine_name, AVG(completed_at - started_at) as avg_lifetime_ms
FROM instance_summary
WHERE completed_at IS NOT NULL
GROUP BY machine_name;
```

## Implementation Strategy

### Option A: Application-level (recommended)

The event processor already runs in a transaction when updating state. Add
derived view updates to the same transaction:

```ts
// In processEvent, after transition log insert:
if (!stateValueEquals(prevStateValue, current.value)) {
  await store.logTransition(client, instanceId, prevStateValue, current.value, event.type, ts);
  await store.closeStateDuration(client, instanceId, ts);
  await store.openStateDuration(client, instanceId, current.value, ts);
  await store.incrementTransitionCount(client, machineName, prevStateValue, current.value, event.type);
}
```

Pros: same transaction guarantees, no PG trigger complexity, testable in
application code.

Cons: more store methods, more writes per transaction.

### Option B: PG triggers

A trigger on `transition_log` `AFTER INSERT` updates the derived tables.

Pros: automatic, can't forget to update.

Cons: trigger debugging is harder, trigger logic is invisible to application
tests, harder to evolve schema.

**Recommendation**: Option A. The event processor is already the single writer
for all instance state. Adding derived view updates there keeps the write path
explicit and testable.

## Store Interface

```ts
// State durations
openStateDuration(client: PoolClient, instanceId: string, stateValue: StateValue, ts: number): Promise<void>;
closeStateDuration(client: PoolClient, instanceId: string, ts: number): Promise<void>;
getStateDurations(instanceId: string): Promise<StateDurationRow[]>;
getAggregateStateDurations(machineName: string): Promise<AggregateStateDuration[]>;

// Transition counts
incrementTransitionCount(client: PoolClient, machineName: string, from: StateValue | null, to: StateValue, event: string): Promise<void>;
getTransitionCounts(machineName: string): Promise<TransitionCountRow[]>;

// Instance summary
upsertInstanceSummary(client: PoolClient, instanceId: string, machineName: string, ts: number): Promise<void>;
completeInstanceSummary(client: PoolClient, instanceId: string, finalState: StateValue, ts: number): Promise<void>;
getInstanceSummaries(machineName: string, opts?: { status?: string; limit?: number }): Promise<InstanceSummaryRow[]>;
```

## Public API

### `DurableMachineHandle`

No changes — `getVisualizationState()` can optionally read from the materialized
`state_durations` table instead of computing on the fly (internal optimization,
same external interface).

### REST API

New aggregate endpoints scoped to a machine, not an instance:

```
GET /machines/:machineId/analytics/state-durations
GET /machines/:machineId/analytics/transitions
GET /machines/:machineId/analytics/summary
```

These return pre-aggregated data from the materialized views.

## Incremental Adoption

The views are additive — they don't change existing behavior. The implementation
can be phased:

1. **Phase 1**: `state_durations` only — highest value, replaces on-read
   computation, enables stuck-instance alerts
2. **Phase 2**: `transition_counts` — enables heatmaps and outcome analysis
3. **Phase 3**: `instance_summary` — enables lifecycle metrics
4. **Phase 4**: REST API endpoints for analytics

Each phase is independently useful and shippable.

## Files

| File | Action |
|------|--------|
| `src/pg/store.ts` | Schema additions, new store methods |
| `src/pg/event-processor.ts` | Add derived view updates to processEvent/processStartup/processTimeout |
| `src/pg/visualization.ts` | Optionally read from `state_durations` instead of computing |
| `src/types.ts` | Add aggregate types (`AggregateStateDuration`, `TransitionCountRow`, etc.) |
| `src/pg/index.ts` | Export new types |
| `packages/gateway/src/rest-api.ts` | Add analytics endpoints |
| `tests/integration/pg/derived-views.test.ts` | Integration tests |

## Non-Goals

- Real-time streaming of analytics (SSE/WebSocket — future work)
- Cross-machine analytics (e.g. "which machine type has the highest error rate")
- Retention policies for derived view data
- Custom user-defined derived views (would require a topology abstraction)
