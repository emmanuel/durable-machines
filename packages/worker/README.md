# @durable-xstate/worker

Worker process lifecycle for durable XState machines. Handles configuration, machine registration, admin server, graceful shutdown, and Prometheus metrics in a structured three-phase startup.

## Install

```bash
npm install @durable-xstate/worker
```

## Quick start (generic)

```typescript
import { parseWorkerConfig, createWorkerContext, startWorker } from "@durable-xstate/worker";
import type { WorkerAppContext } from "@durable-xstate/worker";
import { createPgWorkerContext } from "@durable-xstate/worker/pg";
import { orderMachine } from "./machines/order.js";

const workerConfig = parseWorkerConfig();
const appContext: WorkerAppContext = createPgWorkerContext(pgConfig);

const ctx = createWorkerContext(workerConfig, appContext, {
  machines: {
    orders: { machine: orderMachine },
  },
});

const handle = await startWorker(ctx);
```

## DBOS backend

```typescript
import { parseDBOSWorkerConfig, createDBOSWorkerContext, startDBOSWorker } from "@durable-xstate/worker/dbos";
import { consoleChannel } from "@durable-xstate/durable-machine";
import { orderMachine } from "./machines/order.js";

const config = parseDBOSWorkerConfig();
const ctx = await createDBOSWorkerContext(config, {
  machines: {
    orders: { machine: orderMachine, options: { channels: [consoleChannel()] } },
  },
});
const handle = await startDBOSWorker(ctx);

// Access machines via Map
const dm = ctx.machines.get("orders")!;
const instance = await dm.start("order-1", { items: [] });
```

Requires `@dbos-inc/dbos-sdk` peer dependency.

## PG backend

Using the convenience `startPgWorker`:

```typescript
import { startPgWorker } from "@durable-xstate/worker/pg";
import { parsePgConfig } from "@durable-xstate/durable-machine/pg";
import { parseWorkerConfig } from "@durable-xstate/worker";

const pgConfig = parsePgConfig();
const workerConfig = parseWorkerConfig();

const handle = await startPgWorker(pgConfig, workerConfig, {
  machines: { orders: { machine: orderMachine } },
});
```

Or step by step:

```typescript
import { createPgWorkerContext } from "@durable-xstate/worker/pg";
import { createWorkerContext, startWorker, parseWorkerConfig } from "@durable-xstate/worker";
import { parsePgConfig } from "@durable-xstate/durable-machine/pg";

const pgConfig = parsePgConfig();
const workerConfig = parseWorkerConfig();
const appContext = createPgWorkerContext(pgConfig);

const ctx = createWorkerContext(workerConfig, appContext, {
  machines: { orders: { machine: orderMachine } },
});
await startWorker(ctx);
```

Requires `pg` peer dependency.

## Three-phase startup

| Phase | Function | What it does |
|-------|----------|--------------|
| 1. Parse | `parseWorkerConfig()` or backend-specific parser | Validates env vars, returns typed config |
| 2. Build | `createWorkerContext()` | Creates metrics, registers machines, creates admin server |
| 3. Run | `startWorker()` | Binds admin port, starts backend, wires signal handlers, returns shutdown handle |

## Configuration

| Env var | Type | Default | Description |
|---------|------|---------|-------------|
| `ADMIN_PORT` | number | *(none)* | Port for admin/metrics server. Omit to disable. |
| `GRACEFUL_SHUTDOWN_TIMEOUT_MS` | number | `30000` | Max time for in-flight work to drain on shutdown |

## Admin server

When `ADMIN_PORT` is set, an HTTP server is created with three endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Always returns `200 { "status": "ok" }` |
| `GET /ready` | Returns `200` when ready, `503` during shutdown |
| `GET /metrics` | Prometheus text format metrics |

The admin server is optional for the worker (unlike the gateway, which always enables it). Omit `ADMIN_PORT` to disable.

## Metrics

When the admin server is enabled, the following Prometheus histograms are recorded during startup:

| Metric | Labels | Description |
|--------|--------|-------------|
| `worker_machine_registration_duration_seconds` | `machine_id` | Time to register each machine |
| `worker_backend_start_duration_seconds` | *(none)* | Time for backend start (DBOS launch, PG schema init, etc.) |

Default process metrics (CPU, memory, event loop) are also collected via `prom-client`.

To create metrics independently (e.g., for testing or custom setups):

```typescript
import { createWorkerMetrics } from "@durable-xstate/worker";

const metrics = createWorkerMetrics();        // creates its own Registry
const metrics = createWorkerMetrics(registry); // uses an existing Registry
```

## Graceful shutdown

On `SIGTERM` or `SIGINT`:

1. Readiness probe (`/ready`) starts returning `503`
2. Admin server stops accepting new connections
3. In-flight connections drain up to `shutdownTimeoutMs`
4. Backend shutdown (e.g. `DBOS.shutdown()` or PG pool close)
5. Process exits

## API

### `parseWorkerConfig(env?)`

Validates `ADMIN_PORT` and `GRACEFUL_SHUTDOWN_TIMEOUT_MS` from environment variables (or a custom env record). Returns a `WorkerConfig`.

### `createWorkerContext(config, appContext, options)`

Registers all machines via `appContext.register()`, optionally creates the admin server. Returns a `WorkerContext`.

### `startWorker(ctx)`

Binds the admin server, starts the backend via `appContext.start()`, wires signal handlers. Returns a `WorkerHandle` with a `shutdown()` method for programmatic shutdown.

### `createAdminServer(options?)`

Lower-level: creates the HTTP server without binding a port. Useful when composing with other servers.

### `createWorkerMetrics(registry?)`

Creates a `WorkerMetrics` object with both startup histograms registered on the given (or new) `Registry`.

## License

MIT
