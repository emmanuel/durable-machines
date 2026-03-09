# Server-Rendered Dashboard for Gateway

## Context

The gateway has a full REST API (JSON) for managing durable machine instances,
and the `durable-machine` package has visualization utilities
(`serializeMachineDefinition`, `getVisualizationState`, `computeStateDurations`,
`detectActiveStep`). No frontend exists. We're adding a server-rendered HTML
dashboard that ships with the gateway — zero build step, zero new dependencies.

## Approach

Template-literal HTML (not JSX — avoids tsconfig changes). Inline CSS + inline
JS. Client-side ELK (elkjs via CDN) for state graph layout. SSE for live
updates. Mounted as a Hono sub-app alongside the existing REST API.

## File Structure

All new files in `packages/gateway/src/dashboard/`:

```
dashboard/
  index.ts       -- createDashboard() factory, exports
  routes.ts      -- Hono route handlers (HTML + SSE + form POST)
  html.ts        -- Template functions (layout, machine-list, instance-list, instance-detail)
  graph.ts       -- SerializedMachine → graph data JSON for client-side ELK
  styles.ts      -- CSS string constant
  client.ts      -- Client-side JS string constant (graph render, SSE, event sender)
```

## Routes

All under configurable `dashboardPath` (default `/dashboard`):

| Method | Path | Response | View |
|--------|------|----------|------|
| GET | `/` | HTML | Machine list |
| GET | `/:machineId` | HTML | Instance list |
| GET | `/:machineId/:instanceId` | HTML | Instance detail |
| GET | `/sse/:machineId` | SSE | Instance list live updates |
| GET | `/sse/:machineId/:instanceId` | SSE | Instance detail live updates |
| POST | `/:machineId/:instanceId/send` | redirect | Send event from UI form |

## Integration Points

### DashboardOptions

```typescript
interface DashboardOptions {
  machines: MachineRegistry;
  basePath?: string;          // where dashboard is mounted, default "/dashboard"
  restBasePath?: string;      // REST API base path (for event sender), default ""
  store?: {                   // optional — enables NOTIFY-driven SSE
    startListening(cb: (machineName: string, instanceId: string, topic: string) => void): Promise<void>;
    stopListening(): Promise<void>;
  };
  pollIntervalMs?: number;    // fallback poll interval, default 2000
}
```

### Existing files to modify

- `packages/gateway/src/lifecycle.ts` — add `dashboardPath?: string` and
  optional `store?: PgStore` to `GatewayContextOptions`, mount dashboard in
  `createGatewayContext()`
- `packages/gateway/src/index.ts` — re-export `createDashboard`, `DashboardOptions`

### Existing functions to reuse

- `serializeMachineDefinition(machine)` from `durable-machine/src/visualization.ts`
  — produces the static graph (SerializedMachine)
- `computeStateDurations(transitions)` from same file — timing per state visit
- `detectActiveStep(steps)` from same file — find in-progress step
- `getAvailableEvents(machine, snapshot)` from `gateway/src/hateoas.ts`
  — populate event sender dropdown
- `DurableMachineHandle.getState()`, `.getSteps()`, `.send()`, `.listEffects?()`,
  `.getEventLog?()` — all runtime data

### No PG-specific code in the dashboard

The dashboard uses only the `DurableMachine` / `DurableMachineHandle` interface,
which works with both DBOS and PG backends. `getVisualizationState()` (PG-specific)
is NOT used — instead, the dashboard calls the generic handle methods directly
and assembles the visualization data itself.

## Graph Rendering

### Server side: `graph.ts`

`extractGraphData(definition: SerializedMachine)` → `GraphData`:
- Walks `definition.states`, emits nodes (id, label, type, durable, hasPrompt, hasInvoke, parent, children)
- Extracts edges from `on`, `always`, `after` properties (source, target, label, type)
- Returns JSON embedded in HTML as `<script type="application/json">`

### Client side: inline JS

1. Load `elkjs` from CDN (`https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk.bundled.js`)
2. Convert `GraphData` to ELK format (compound nodes for compound/parallel states)
3. Compute layout with `elk.layout()` (algorithm: `layered`, direction: `DOWN`)
4. Render SVG into `#graph-container` — rects for states, paths for edges, arrowheads
5. Apply runtime overlay: highlight active state, show duration badges, visited states

### Fallback layout (no CDN)

If ELK fails to load, a manual top-down layout assigns states to rows by
transition depth and spaces evenly. Edges are straight lines. Crude but readable.

### Node visual encoding

- Durable states: thicker border + shield icon
- Prompt states: speech bubble badge
- Invoke states: gear icon
- Final states: double border
- Active state: pulsing glow (CSS animation)
- Visited states: lighter accent border

## Instance Detail Layout

Four-panel grid (collapses to single column on mobile):

```
┌──────────────────────────┬─────────────────────┐
│                          │ Transition Timeline  │
│  State Graph (SVG)       │ (vertical, newest    │
│                          │  first, scrollable)  │
│                          │                      │
├──────────────────────────┼─────────────────────┤
│ Context Inspector        │ Event Sender         │
│ (collapsible JSON tree)  │ (dropdown + payload  │
│                          │  textarea + button)  │
└──────────────────────────┴─────────────────────┘
```

### Transition Timeline

From `transitions` + `stateDurations`: shows each state visit with timestamp,
event that caused the transition, and duration. Active state has live-ticking
counter.

### Context Inspector

Recursive `<details>` elements for nested objects. Top 2 levels open by
default. Updates live via SSE.

### Event Sender

`<select>` populated from `getAvailableEvents()`. Optional JSON payload
`<textarea>`. Submits via `fetch()` (intercepted form) so the page updates
via SSE without reload. Falls back to form POST + redirect if JS disabled.

## SSE Design

### Push vs poll

The PG backend already has `LISTEN/NOTIFY` — the `event_log_trigger` fires
`pg_notify('machine_event', machineName::instanceId::topic)` on every event
insert. The worker process uses `PgStore.startListening()` for this.

The dashboard uses the same mechanism: `DashboardOptions` accepts an optional
`store?: PgStore`. When provided, the dashboard calls `store.startListening()`
to receive NOTIFY signals and pushes SSE immediately — zero polling latency.
When not provided (DBOS backend), falls back to polling (2s interval).

### `/sse/:machineId/:instanceId`

On NOTIFY for this instanceId (or on poll interval): fetches snapshot, steps,
transitions via the DurableMachineHandle. Compares with last-sent state. Only
emits on change.

Events:
- `state` — `{ snapshot, steps, transitions, effects, availableEvents }`
- `complete` — `{ status }` (stream ends)

### `/sse/:machineId`

On any NOTIFY for this machineName (or on poll interval): fetches instance list.

Events:
- `instances` — `{ instances: DurableMachineStatus[] }`

## CSS

Dark theme. Single CSS string constant. CSS custom properties for theming.
Minimal — functional, not decorative.

## Implementation Status

All phases implemented in a single pass. Typecheck clean, all 267 gateway
tests passing.

### Phase 1: Skeleton + Machine List — DONE

- `dashboard/index.ts` — `createDashboard()` factory
- `dashboard/routes.ts` — GET `/` handler
- `dashboard/html.ts` — `layout()` + `machineListPage()` templates
- `dashboard/styles.ts` — CSS constant
- Modified `lifecycle.ts` + `index.ts` for mounting

### Phase 2: Instance List — DONE

- GET `/:machineId` route with `instanceListPage()` template
- Status filter via `?status=` query param
- Links to detail view

### Phase 3: Instance Detail (static) — DONE

- GET `/:machineId/:instanceId` route with `instanceDetailPage()` template
- Context inspector panel (recursive `<details>` JSON tree)
- Transition timeline panel
- Event sender form (POST `/:machineId/:instanceId/send` → `handle.send()` → redirect)
- Steps panel with status badges and duration
- Effects panel (when `listEffects` available)
- Event log panel (when `getEventLog` available)

### Phase 4: State Graph — DONE

- `dashboard/graph.ts` — `extractGraphData()` (nodes + edges from SerializedMachine)
- `dashboard/client.ts` — client-side JS for ELK layout + SVG rendering + overlay
- Graph data + runtime state embedded as JSON in HTML
- Active state highlighting + visited state overlay
- Fallback layout when CDN unavailable

### Phase 5: Live Updates — DONE

- SSE endpoints: `/sse/:machineId` and `/sse/:machineId/:instanceId`
- Uses `hono/streaming` `streamSSE()` for SSE responses
- NOTIFY-driven push when `store` provided, polling fallback otherwise
- Client JS connects `EventSource`, updates all panels on `state` events
- Live-ticking duration counter on active state
- Auto-close on `complete` event
- Instance list auto-refresh

### Phase 6: Polish — DONE

- Breadcrumb navigation
- Effect status panel (if `listEffects` available)
- Event log panel (if `getEventLog` available)
- Step history with timing details
- SSE connection indicator (green/red/yellow dot)
- Status badge updates via SSE
- Available events dropdown updates via SSE
- Error display panel (instance errors, failed steps, failed effects)
- Active sleep countdown (live countdown timer for `after` delayed transitions)
  - `GraphEdge.delay` field for numeric after-edge delays
  - `computeActiveSleep()` computes `wakeAt = enteredAt + delay` from graph + active states + durations
  - Countdown badge in both timeline and graph SVG (ELK + fallback)
  - 200ms ticker updates countdown elements; `.firing` class when timer expires
  - Included in SSE state updates for real-time countdown

## Verification

```bash
# Unit: ensure gateway still builds and existing tests pass
pnpm --filter gateway typecheck
pnpm --filter gateway test

# Manual: start a gateway with machines registered, open /dashboard/
# - Verify machine list shows registered machines
# - Verify instance list shows instances
# - Verify instance detail shows graph, timeline, context, event sender
# - Verify sending an event updates the view
# - Verify SSE updates reflect state changes in real time
```
