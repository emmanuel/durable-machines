# Plan: Append-Only Inbound Event Log

## Status: Done

Implemented in commit `2cc47e3` (replace transient message queue with append-only
event log).

## Problem

The PG backend uses `machine_messages` as a work queue: events are inserted,
consumed (marked `consumed = true`), and the payload is processed. The consumed
flag is the only record that an event was ever received. The `transition_log`
records state changes, but not the raw inbound events that caused them — and
events that don't produce a transition (e.g. ignored events, events to
non-running instances) leave no trace at all.

This makes several things impossible today:

1. **Debugging** — "What events did instance X receive, in what order?" requires
   correlating transition log entries with application logs. Events that were
   ignored or arrived at the wrong time are invisible.
2. **Replay** — Re-processing an instance's event history against a new machine
   definition (e.g. after a bug fix) requires an external event source.
3. **Audit** — Compliance scenarios need a complete record of every input the
   system received, not just the state changes that resulted.
4. **Dead letter analysis** — Events sent to non-existent or completed instances
   vanish silently.

## Core Insight

`machine_messages` already stores every inbound event durably before processing.
The only change is to stop treating it as a transient queue and start treating it
as an append-only log. Instead of marking rows `consumed = true`, we track a
per-instance consumption cursor. The log grows, but old entries can be compacted
by a separate GC policy without affecting correctness.

This is inspired by Rama's depot model (append-only durable logs as source of
truth), adapted to PG: keep the log, advance a cursor, compact later.

## Schema Changes

### New: `event_log` table

Replace the current `machine_messages` dual-purpose table with a dedicated
append-only event log. The existing `machine_messages` consumption logic moves to
a cursor-based model.

```sql
CREATE TABLE IF NOT EXISTS event_log (
  instance_id     TEXT NOT NULL REFERENCES machine_instances(id) ON DELETE CASCADE,
  seq             BIGSERIAL,
  topic           TEXT NOT NULL DEFAULT 'event',
  payload         JSONB NOT NULL,
  created_at      BIGINT NOT NULL,
  -- Optional: who sent it (for audit)
  source          TEXT,
  PRIMARY KEY (instance_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_el_pending
  ON event_log (instance_id, seq)
  WHERE seq > 0;
```

### New: consumption cursor on `machine_instances`

```sql
ALTER TABLE machine_instances
  ADD COLUMN event_cursor BIGINT NOT NULL DEFAULT 0;
```

The event processor reads events where `seq > event_cursor`, processes them, and
advances the cursor atomically with the state update.

### Migration from `machine_messages`

The `machine_messages` table continues to exist during migration. New events are
written to `event_log`. The consumption query changes from:

```sql
-- Before: destructive consumption
UPDATE machine_messages SET consumed = true
WHERE id = (SELECT id FROM machine_messages
            WHERE instance_id = $1 AND consumed = false
            ORDER BY created_at LIMIT 1
            FOR UPDATE SKIP LOCKED)
RETURNING *
```

to:

```sql
-- After: cursor-based read
SELECT seq, topic, payload, created_at
FROM event_log
WHERE instance_id = $1 AND seq > $2
ORDER BY seq ASC
LIMIT 1
```

The cursor is advanced in the same transaction that updates instance state:

```sql
UPDATE machine_instances
SET state_value = $2, context = $3, ..., event_cursor = $4
WHERE id = $1
```

### NOTIFY trigger

Same pattern as today — `AFTER INSERT` on `event_log` fires a notification for
sub-second reactivity.

## Store Interface Changes

```ts
// New method
appendEvent(
  instanceId: string,
  payload: unknown,
  topic?: string,
  source?: string,
): Promise<{ seq: number }>;

// Changed: returns next unconsumed event based on cursor
consumeNextEvent(
  client: PoolClient,
  instanceId: string,
  currentCursor: number,
): Promise<{ seq: number; payload: unknown; topic: string } | null>;

// New: query the full event history
getEventLog(
  instanceId: string,
  opts?: { afterSeq?: number; limit?: number },
): Promise<EventLogEntry[]>;
```

```ts
export interface EventLogEntry {
  seq: number;
  topic: string;
  payload: unknown;
  source?: string;
  createdAt: number;
}
```

## Event Processor Changes

The event processor currently calls `store.consumeMessage(client, instanceId)`.
This changes to `store.consumeNextEvent(client, instanceId, cursor)`, and the
cursor is advanced alongside the state update in the same transaction.

Key invariant: **cursor advance is atomic with state change.** If the transaction
rolls back, the cursor stays put and the event will be reprocessed on retry.

## Public API

### `DurableMachineHandle`

```ts
/** Return the ordered log of all events received by this instance. */
getEventLog?(opts?: { limit?: number }): Promise<EventLogEntry[]>;
```

### REST API

```
GET /machines/:machineId/instances/:instanceId/events/log
```

Returns the append-only event log for the instance. Supports `?limit=N` and
`?after=seq` for pagination.

## Compaction / GC

Old event log entries can be pruned by a background job without affecting
correctness — the cursor only moves forward. Options:

- **Time-based**: delete entries older than N days
- **Cursor-based**: delete entries with `seq <= min(event_cursor)` across all
  instances of a machine (safe because no instance will re-read them)
- **Status-based**: delete entries for completed/cancelled instances after a
  retention period

GC is out of scope for the initial implementation but the schema supports it.

## Files

| File | Action |
|------|--------|
| `src/pg/store.ts` | Schema change, new `appendEvent`, `consumeNextEvent`, `getEventLog` methods |
| `src/pg/event-processor.ts` | Switch from `consumeMessage` to cursor-based consumption |
| `src/pg/create-durable-machine.ts` | Add `getEventLog` to handle |
| `src/types.ts` | Add `EventLogEntry` type, `getEventLog` to `DurableMachineHandle` |
| `src/index.ts` | Export `EventLogEntry` |
| `packages/gateway/src/rest-api.ts` | Add `GET .../events/log` route |
| `tests/conformance/event-log.ts` | Conformance tests |
| `tests/integration/pg/event-log.test.ts` | PG integration glue |

## Non-Goals

- Replaying events against a new machine definition (future work on top of this)
- Cross-instance event correlation (would require a global event log)
- Streaming/tailing the log in real-time (SSE extension, future work)
