# Unified Activity Feed — Design Spec

## Problem

The instance detail dashboard displays three separate panels — transition timeline, steps table, and event log — as disconnected cards. These panels show causally related data (events trigger transitions, transitions invoke steps) but the relationships aren't visible. Users must mentally correlate timestamps across panels to understand what happened.

## Solution

Replace the three panels with a single **unified activity feed**: a chronological stream where each row is a state transition (or unmatched event), expandable to show rich detail including the triggering event, step results, effects, and context diffs.

## Design Decisions

- **Transition-centric with event fallback**: Primary rows are state transitions. Events that didn't produce a transition appear as secondary (dimmed) rows so nothing is lost.
- **Self-transitions**: Shown with a distinct visual treatment (yellow dot, "self" tag, "re-entered" label) instead of confusing `A → A` arrow notation.
- **Context snapshots gated by analytics**: The `context_snapshot` JSONB column in `transition_log` is only populated when `enableAnalytics: true`. Context diffs are omitted when snapshots aren't available.
- **Expand/collapse via `<details>`**: Collapsed rows show dot + state change + inline tags. Expanded rows show full detail. No hover-dependent interactions.
- **Replaces three panels**: Transition timeline, steps table, and event log are removed. Their data is folded into the unified feed.

## Data Model

### Schema Changes

**transition_log**: Add `context_snapshot JSONB` column (nullable). Populated only when `enableAnalytics` is enabled. Captures machine context *after* each transition.

Both the `SCHEMA_SQL` definition in `packages/durable-machine/src/pg/schema.ts` (for new databases) and a separate `ALTER TABLE` migration (for existing databases) must be updated.

**Q_GET_TRANSITIONS**: Extend to also select the `event` column (already written to `transition_log` but not currently fetched). Update `TransitionRecord` type accordingly.

**Q_APPEND_TRANSITION / Q_FINALIZE_WITH_TRANSITION**: Extend parameter lists to accept and insert `context_snapshot` alongside the existing columns.

### Activity Entry Type

```typescript
interface ActivityEntry {
  kind: "transition" | "self-transition" | "unmatched-event";
  ts: number;

  // Present for transition / self-transition
  from?: StateValue | null;
  to?: StateValue;
  event?: string;        // from transition_log.event column

  // Correlated data (populated server-side)
  eventPayload?: unknown;           // from event_log.payload
  step?: {                          // from invoke_results
    name: string;
    durationMs: number | null;
    output?: unknown;
    error?: unknown;
  };
  effects?: {                       // from effect_outbox
    effectType: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    lastError?: string;
  }[];
  contextDiff?: {                   // computed from consecutive context_snapshots
    key: string;
    before: unknown;
    after: unknown;
  }[];

  // Present for unmatched-event
  eventType?: string;               // from event_log.payload.type
  payload?: unknown;                // event_log.payload
  seq?: number;                     // event_log.seq
}
```

Note: `guard` is not stored in `transition_log`. Guard labels visible on collapsed rows come from the static machine definition by matching (event, from, to) against `SerializedStateNode.on` transition rules. This is a best-effort lookup — if no match is found, the guard tag is omitted.

## Feed Composition (Server-Side)

The dashboard route handler builds `ActivityEntry[]`:

1. Fetch `transitions` (extended with `event` column), `event_log`, `invoke_results`, `effects` using existing/updated queries.
2. For each transition, correlate:
   - **Triggering event**: Match `transition.event` against `event_log.payload.type` (the event type is inside the JSONB payload, not in `event_log.topic` which is a generic discriminator like `"event"`). Correlate by closest `event_log.created_at` to `transition.ts`.
   - **Step result**: Match `invoke_results` by timestamp range — find entries where `started_at <= transition.ts <= completed_at`, or where `step_key` matches a known invoke `src` on the transition's `from` state node (cross-referenced from `SerializedStateNode.invoke` metadata).
   - **Effects**: Match from `effect_outbox` by `(instance_id, state_value)` where `state_value` matches the transition's `from` state.
   - **Context diff**: Diff `transition[i].context_snapshot` vs `transition[i-1].context_snapshot` (when snapshots present). Shallow diff of top-level keys only; nested objects shown as changed if not reference-equal. Limit to 20 keys max to avoid unwieldy output for large contexts.
3. Mark transitions where `from === to` (deep equal for nested state values) as `kind: "self-transition"`.
4. Collect unmatched `event_log` entries (not correlated to any transition) as `kind: "unmatched-event"`. The event type is extracted from `payload.type`.
5. Merge all entries and sort chronologically.

## Rendering

### Functions

**Server-side** (`instance-detail.ts`): `renderActivityFeed(feed: ActivityEntry[]): string` — generates initial HTML for the feed. Each entry is a `<details>` element. Returns the inner HTML for `<div class="activity-feed" id="activity-feed">`.

**Client-side** (`client.ts`): `renderActivityFeed(feed)` — rebuilds the feed DOM from an `ActivityEntry[]` received via SSE. Same HTML structure as server-side.

### Layout

The unified feed occupies the current timeline panel position (top-right of the `.detail-grid`). It replaces the timeline panel class with `.activity-panel`.

### Collapsed Row

Each row displays:
- Color-coded dot: blue (transition), yellow (self-transition), purple/dimmed (unmatched event)
- State change text (`from → to`) or event type for unmatched events
- Inline tags: event name, step status + duration, guard label (when resolvable)
- Timestamp (right-aligned)
- Chevron indicating expand state

### Expanded Row (Rich Detail)

Clicking a row expands a detail panel showing (when available):
- **Trigger**: The event that caused this transition (shortened name + payload)
- **Step**: Name, duration, output (JSON), or error with full message
- **Effects**: Type, status, attempt count
- **Context diff**: Key-by-key before/after values (only when `context_snapshot` is available)

### Visual Treatment

- Compact spacing: 5px vertical padding, 5-8px gaps between elements
- Self-transitions: yellow dot, "self" tag, state name without arrow
- Unmatched events: 55% opacity, no chevron, purple dot
- Detail panel: left blue border, subtle background tint
- Error detail: red-tinted box with pre-wrapped error message

### Sort Toggle

The existing sort direction toggle (newest-first / oldest-first) carries over to the unified feed.

## SSE Live Updates

The SSE `state` event payload is extended with an `activityFeed: ActivityEntry[]` field. The server composes the feed on each state change (same logic as initial page render) and sends it as part of the SSE data.

Client-side `renderActivityFeed(data.activityFeed)` replaces the current `renderTimeline()` and `updateEventLog()` calls.

## What Gets Removed

### Server-side (`instance-detail.ts`)
- `renderTimelineEntries()` — replaced by `renderActivityFeed()`
- Steps table HTML generation
- Event log HTML generation

### Client-side (`client.ts`)
- `renderTimeline()` — replaced by `renderActivityFeed()`
- `updateEventLog()` — no longer needed
- `lastTimelineData` / timeline sort state — replaced by `lastActivityFeed` / same sort toggle

### Panels retained as-is
- State graph (top-left)
- Context panel (bottom-left)
- Event sender (bottom-right)
- Effects panel (full-width below grid)
- Analytics panel (full-width below grid)

## Migration

### Database
- Add `context_snapshot JSONB` column to `transition_log` in `SCHEMA_SQL` (for new databases)
- Add `ALTER TABLE ... ADD COLUMN IF NOT EXISTS context_snapshot JSONB` in schema provisioning (for existing databases, same pattern as existing `ADD COLUMN IF NOT EXISTS` on line 16 of `schema.ts`)
- Update `Q_APPEND_TRANSITION` and `Q_FINALIZE_WITH_TRANSITION` parameter lists to include `context_snapshot`

### Backward Compatibility
- Existing `transition_log` rows have `NULL` context_snapshot — feed renders without context diffs for historical data
- The feed works without analytics enabled — it just omits context diffs
- No data migration needed — new column is nullable with no default
