# Plan: HTTP REST Gateway

## Status: Planned

Prerequisite: none (works with any `DurableMachine` backend). Enhanced by
machine-definition-as-data plan (dynamic machine registration via API).

## Problem

Every backend (`pg`, `dbos`, future `cloudflare`) produces a `DurableMachine` with the
same interface (`start`, `get`, `list`, `send`, `getState`, `getResult`, `getSteps`,
`cancel`). But exposing these over HTTP requires each consumer to write their own routes,
request parsing, error handling, and response formatting.

This is boilerplate. Worse, without a standard response format, clients can't discover
what events a machine accepts in its current state — they need out-of-band documentation.

## Core Insight

A generic REST API factory takes a registry of `DurableMachine` instances and returns a
Hono app with HATEOAS responses. Because Hono runs on CF Workers, Node.js, Deno, and
Bun, the same gateway works on every platform — matching the backend-agnostic philosophy
of the library.

HATEOAS links tell clients *what they can do next*: available events, result endpoint,
cancel action. The machine definition itself — via `resolveState()` and state node
inspection — provides the available event types at runtime.

## Package Location

```
packages/gateway/src/
  rest-api.ts        — createRestApi() factory
  rest-types.ts      — MachineRegistry, StateResponse, HateoasLinks, RestApiOptions
  hateoas.ts         — link builder + available events computation
  index.ts           — re-exports
```

The gateway lives in the existing `packages/gateway/` package (which currently has
webhook/event source routing). The REST API is a new module alongside existing gateway
functionality.

## Types

```ts
// rest-types.ts

import type { DurableMachine } from "@durable-xstate/durable-machine";

/** Map of machine name → DurableMachine instance */
export type MachineRegistry = Map<string, DurableMachine>;

/** Options for createRestApi() */
export interface RestApiOptions {
  /** Map of machine name → DurableMachine */
  machines: MachineRegistry;

  /** Base path prefix for all routes. Default: "" */
  basePath?: string;

  /** Enable URL-as-API shorthand routes (single-machine mode). Default: false */
  shorthand?: boolean;
}

/** HATEOAS links included in every state response */
export interface HateoasLinks {
  /** URL to read current state */
  self: string;

  /** URL to send events to this instance */
  send: string;

  /** Available event types the machine accepts in its current state */
  events: string[];

  /** URL to read the final result (when machine reaches a final state) */
  result: string;

  /** URL to list durable steps executed so far */
  steps: string;

  /** URL to cancel the instance */
  cancel: string;
}

/** Standard state response body */
export interface StateResponse {
  /** The machine instance ID */
  instanceId: string;

  /** Current state value */
  state: unknown;

  /** Current context */
  context: Record<string, unknown>;

  /** Workflow status: "running", "done", or "error" */
  status: string;

  /** HATEOAS navigation links */
  links: HateoasLinks;
}

/** Error response body */
export interface ErrorResponse {
  error: string;
  detail?: string;
}
```

## Routes

All routes are scoped under `{basePath}/machines/:machineId/instances`.

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| `POST` | `/machines/:machineId/instances` | `start` | Create a new instance |
| `GET` | `/machines/:machineId/instances` | `list` | List instances (optional `?status=` filter) |
| `GET` | `/machines/:machineId/instances/:instanceId` | `getState` | Read current state |
| `POST` | `/machines/:machineId/instances/:instanceId/events` | `send` | Send an event |
| `GET` | `/machines/:machineId/instances/:instanceId/result` | `getResult` | Read final result |
| `GET` | `/machines/:machineId/instances/:instanceId/steps` | `getSteps` | List executed steps |
| `DELETE` | `/machines/:machineId/instances/:instanceId` | `cancel` | Cancel the instance |

### Route implementations

#### `POST /machines/:machineId/instances`

```ts
// Request body: { instanceId: string, input: Record<string, unknown> }
// Response: 201 with StateResponse
app.post("/:machineId/instances", async (c) => {
  const machineId = c.req.param("machineId");
  const durable = machines.get(machineId);
  if (!durable) return c.json({ error: "Machine not found" }, 404);

  const { instanceId, input } = await c.req.json();
  const handle = await durable.start(instanceId, input ?? {});
  const snapshot = await handle.getState();

  return c.json(toStateResponse(durable, machineId, instanceId, snapshot), 201);
});
```

#### `GET /machines/:machineId/instances`

```ts
// Query: ?status=running (optional)
// Response: 200 with array of { workflowId, status, workflowName }
app.get("/:machineId/instances", async (c) => {
  const machineId = c.req.param("machineId");
  const durable = machines.get(machineId);
  if (!durable) return c.json({ error: "Machine not found" }, 404);

  const status = c.req.query("status");
  const list = await durable.list(status ? { status } : undefined);

  return c.json(list);
});
```

#### `GET /machines/:machineId/instances/:instanceId`

```ts
// Response: 200 with StateResponse, or 404
app.get("/:machineId/instances/:instanceId", async (c) => {
  const { machineId, instanceId } = c.req.param();
  const durable = machines.get(machineId);
  if (!durable) return c.json({ error: "Machine not found" }, 404);

  const snapshot = await durable.get(instanceId).getState();
  if (!snapshot) return c.json({ error: "Instance not found" }, 404);

  return c.json(toStateResponse(durable, machineId, instanceId, snapshot));
});
```

#### `POST /machines/:machineId/instances/:instanceId/events`

```ts
// Request body: { type: string, ...payload }
// Response: 200 with StateResponse after transition
app.post("/:machineId/instances/:instanceId/events", async (c) => {
  const { machineId, instanceId } = c.req.param();
  const durable = machines.get(machineId);
  if (!durable) return c.json({ error: "Machine not found" }, 404);

  const event = await c.req.json();
  const handle = durable.get(instanceId);
  await handle.send(event);

  const snapshot = await handle.getState();
  if (!snapshot) return c.json({ error: "Instance not found" }, 404);

  return c.json(toStateResponse(durable, machineId, instanceId, snapshot));
});
```

#### `GET /machines/:machineId/instances/:instanceId/result`

```ts
// Response: 200 with { result: context } when done, or 202 if still running
app.get("/:machineId/instances/:instanceId/result", async (c) => {
  const { machineId, instanceId } = c.req.param();
  const durable = machines.get(machineId);
  if (!durable) return c.json({ error: "Machine not found" }, 404);

  const snapshot = await durable.get(instanceId).getState();
  if (!snapshot) return c.json({ error: "Instance not found" }, 404);

  if (snapshot.status === "done") {
    return c.json({ result: snapshot.context });
  }
  if (snapshot.status === "error") {
    return c.json({ error: "Instance errored" }, 500);
  }

  return c.json({ status: "running" }, 202);
});
```

#### `GET /machines/:machineId/instances/:instanceId/steps`

```ts
// Response: 200 with StepInfo[]
app.get("/:machineId/instances/:instanceId/steps", async (c) => {
  const { machineId, instanceId } = c.req.param();
  const durable = machines.get(machineId);
  if (!durable) return c.json({ error: "Machine not found" }, 404);

  const steps = await durable.get(instanceId).getSteps();
  return c.json(steps);
});
```

#### `DELETE /machines/:machineId/instances/:instanceId`

```ts
// Response: 200 with { cancelled: true }
app.delete("/:machineId/instances/:instanceId", async (c) => {
  const { machineId, instanceId } = c.req.param();
  const durable = machines.get(machineId);
  if (!durable) return c.json({ error: "Machine not found" }, 404);

  await durable.get(instanceId).cancel();
  return c.json({ cancelled: true });
});
```

## HATEOAS Response Builder

```ts
// hateoas.ts
import type { AnyStateMachine } from "xstate";
import type { DurableMachine, DurableStateSnapshot } from "@durable-xstate/durable-machine";
import type { HateoasLinks, StateResponse } from "./rest-types.js";

/**
 * Compute available event types for the current state by resolving the
 * snapshot and inspecting active state nodes' `on` handlers.
 */
export function getAvailableEvents(
  machine: AnyStateMachine,
  snapshot: DurableStateSnapshot,
): string[] {
  const resolved = machine.resolveState({
    value: snapshot.value,
    context: snapshot.context,
  });

  const events = new Set<string>();
  for (const node of resolved._nodes) {
    const onHandlers = node.on;
    if (typeof onHandlers === "object" && onHandlers !== null) {
      for (const eventType of Object.keys(onHandlers)) {
        // Skip internal xstate events
        if (!eventType.startsWith("xstate.")) {
          events.add(eventType);
        }
      }
    }
  }

  return [...events].sort();
}

/**
 * Build HATEOAS links for a machine instance.
 */
export function buildLinks(
  basePath: string,
  machineId: string,
  instanceId: string,
  availableEvents: string[],
): HateoasLinks {
  const base = `${basePath}/machines/${machineId}/instances/${instanceId}`;
  return {
    self: base,
    send: `${base}/events`,
    events: availableEvents,
    result: `${base}/result`,
    steps: `${base}/steps`,
    cancel: base,
  };
}

/**
 * Build a full StateResponse with HATEOAS links.
 */
export function toStateResponse(
  durable: DurableMachine,
  basePath: string,
  machineId: string,
  instanceId: string,
  snapshot: DurableStateSnapshot,
): StateResponse {
  const availableEvents = getAvailableEvents(durable.machine, snapshot);
  return {
    instanceId,
    state: snapshot.value,
    context: snapshot.context,
    status: snapshot.status,
    links: buildLinks(basePath, machineId, instanceId, availableEvents),
  };
}
```

### Available events computation

The key insight is that `machine.resolveState({ value, context })` reconstructs a full
XState snapshot from the stored `DurableStateSnapshot`. The snapshot's `_nodes` array
contains the active state nodes. Each node's `.on` getter returns the event handlers
for that state. We collect all non-internal event types to produce the `events` array.

This means the HATEOAS response accurately reflects what the machine can accept
*right now* — not a static list from the definition.

## URL-as-API Shorthand

For single-machine deployments (e.g. a CF Worker hosting one machine), the full
`/machines/:machineId/instances/:instanceId/events` path is verbose. An optional
shorthand mode provides simplified routes inspired by the state.do pattern:

| Method | Path | Maps to |
|--------|------|---------|
| `GET` | `/:instanceId` | Read current state |
| `POST` | `/:instanceId/:event` | Send event `{ type: event }` |
| `POST` | `/:instanceId` | Start instance (body: `{ input }`) |

Enabled via `shorthand: true` in options. Only works when the registry contains a
single machine. The factory throws if `shorthand: true` and `machines.size > 1`.

```ts
if (options.shorthand) {
  const [machineId, durable] = [...machines.entries()][0];

  app.get("/:instanceId", async (c) => {
    const instanceId = c.req.param("instanceId");
    const snapshot = await durable.get(instanceId).getState();
    if (!snapshot) return c.json({ error: "Not found" }, 404);
    return c.json(toStateResponse(durable, basePath, machineId, instanceId, snapshot));
  });

  app.post("/:instanceId/:event", async (c) => {
    const { instanceId, event } = c.req.param();
    const handle = durable.get(instanceId);
    await handle.send({ type: event });
    const snapshot = await handle.getState();
    if (!snapshot) return c.json({ error: "Not found" }, 404);
    return c.json(toStateResponse(durable, basePath, machineId, instanceId, snapshot));
  });

  app.post("/:instanceId", async (c) => {
    const instanceId = c.req.param("instanceId");
    const { input } = await c.req.json();
    const handle = await durable.start(instanceId, input ?? {});
    const snapshot = await handle.getState();
    return c.json(toStateResponse(durable, basePath, machineId, instanceId, snapshot), 201);
  });
}
```

## Factory

```ts
// rest-api.ts
import { Hono } from "hono";
import type { RestApiOptions } from "./rest-types.js";
import { toStateResponse } from "./hateoas.js";

export function createRestApi(options: RestApiOptions): Hono {
  const { machines, basePath = "" } = options;
  const app = new Hono();
  const prefix = basePath ? `${basePath}/machines` : "/machines";

  const machineRoutes = new Hono();

  // ... all route handlers mounted on machineRoutes ...

  app.route(prefix, machineRoutes);

  // Shorthand routes (optional)
  if (options.shorthand) {
    // ... shorthand routes mounted on app ...
  }

  return app;
}
```

### Usage example — Node.js with PG backend

```ts
import { serve } from "@hono/node-server";
import { createDurableMachine } from "@durable-xstate/durable-machine/pg";
import { createRestApi } from "@durable-xstate/gateway";
import { Pool } from "pg";
import { orderMachine, ticketMachine } from "./machines.js";

const pool = new Pool();

const machines = new Map([
  ["order", createDurableMachine(orderMachine, { pool })],
  ["ticket", createDurableMachine(ticketMachine, { pool })],
]);

const app = createRestApi({ machines, basePath: "/api/v1" });

serve({ fetch: app.fetch, port: 3000 });
```

### Usage example — CF Worker with DO backend

```ts
import { createDurableMachine } from "@durable-xstate/cloudflare";
import { createRestApi } from "@durable-xstate/gateway";
import { orderMachine } from "./machines.js";

export default {
  fetch(request: Request, env: Env) {
    const machines = new Map([
      ["order", createDurableMachine(orderMachine, { namespace: env.ORDER_MACHINE })],
    ]);

    const app = createRestApi({ machines });
    return app.fetch(request);
  },
};
```

### Usage example — Shorthand mode

```ts
const machines = new Map([
  ["order", createDurableMachine(orderMachine, { pool })],
]);

const app = createRestApi({ machines, shorthand: true });

// Client usage:
// POST /order-123          → start instance "order-123"
// GET  /order-123          → read state
// POST /order-123/PAY      → send { type: "PAY" }
// POST /order-123/SHIP     → send { type: "SHIP" }
```

## Error Handling

All routes wrap handler bodies in try/catch and return consistent `ErrorResponse`:

```ts
app.onError((err, c) => {
  if (err instanceof DurableMachineError) {
    // Instance not found, not running, already exists, etc.
    const status = err.message.includes("not found") ? 404
      : err.message.includes("already exists") ? 409
      : err.message.includes("not running") ? 409
      : err.message.includes("cancelled") ? 410
      : 500;
    return c.json({ error: err.message }, status);
  }

  return c.json({ error: "Internal server error" }, 500);
});
```

| Error condition | Status | Body |
|----------------|--------|------|
| Machine not in registry | 404 | `{ error: "Machine not found" }` |
| Instance not found | 404 | `{ error: "Instance not found" }` |
| Instance already exists | 409 | `{ error: "Instance ... already exists" }` |
| Instance not running (send to done/cancelled) | 409 | `{ error: "Instance ... is not running" }` |
| Instance cancelled | 410 | `{ error: "Instance ... cancelled" }` |
| Instance errored (getResult) | 500 | `{ error: "Instance ... errored" }` |
| Result not ready | 202 | `{ status: "running" }` |

## New Files

| File | Purpose |
|------|---------|
| `packages/gateway/src/rest-api.ts` | `createRestApi()` factory |
| `packages/gateway/src/rest-types.ts` | `MachineRegistry`, `StateResponse`, `HateoasLinks`, `RestApiOptions`, `ErrorResponse` |
| `packages/gateway/src/hateoas.ts` | `getAvailableEvents()`, `buildLinks()`, `toStateResponse()` |

## Modified Files

| File | Changes |
|------|---------|
| `packages/gateway/src/index.ts` | Re-export `createRestApi` and types |
| `packages/gateway/package.json` | Add `@durable-xstate/durable-machine` as peer dependency |

## Tests

### Unit tests

- `tests/unit/hateoas.test.ts` — `getAvailableEvents()` with various machine shapes
  (simple states, compound states, parallel states), `buildLinks()` path construction,
  `toStateResponse()` assembly
- `tests/unit/rest-api.test.ts` — all routes with mock `DurableMachine` instances:
  - Start: 201 with HATEOAS links, 409 for duplicate
  - List: 200 with array, optional status filter
  - GetState: 200 with HATEOAS links, 404 for missing
  - Send: 200 with updated state, events array reflects new state
  - GetResult: 200 when done, 202 when running, 500 when errored
  - GetSteps: 200 with step array
  - Cancel: 200 with `{ cancelled: true }`
  - Error responses: 404 for unknown machine, consistent format
  - Shorthand routes: GET/POST mapping

### Integration tests

- `tests/integration/pg/rest-api.test.ts` — full end-to-end with PG backend:
  - Start an order, send PAY, verify HATEOAS `events` changes from
    `["PAY"]` to `["SHIP"]`, send SHIP, verify `status: "done"`, get result
  - List instances with status filter
  - Cancel and verify 410 on subsequent send

## Implementation Order

### Phase 1: Types + Routes

1. `rest-types.ts` — all type definitions
2. `rest-api.ts` — `createRestApi()` with all 7 routes
3. Unit tests with mock `DurableMachine`

### Phase 2: HATEOAS + Available Events

4. `hateoas.ts` — `getAvailableEvents()`, `buildLinks()`, `toStateResponse()`
5. Wire HATEOAS responses into all routes
6. Unit tests for available events computation

### Phase 3: Tests + Shorthand

7. Shorthand routes
8. Integration tests against PG backend
9. Error handling refinement
10. Export from `packages/gateway/src/index.ts`
