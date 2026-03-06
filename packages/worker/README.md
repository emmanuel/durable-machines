# @durable-xstate/worker

Worker process lifecycle for durable XState machines. Handles configuration, machine registration, DBOS launch, admin server, graceful shutdown, and Prometheus metrics in a structured three-phase startup.

## Install

```bash
npm install @durable-xstate/worker
```

Peer dependencies: `@dbos-inc/dbos-sdk`, `@durable-xstate/durable-machine`.

## Usage

```typescript
import { parseWorkerConfig, createWorkerContext, startWorker } from "@durable-xstate/worker";
import { consoleChannel } from "@durable-xstate/durable-machine";
import { orderMachine } from "./machines/order.js";

// 1. Parse config from environment
const config = parseWorkerConfig();

// 2. Create context (registers machines, launches DBOS)
const ctx = await createWorkerContext(config, {
  machines: {
    orders: { machine: orderMachine, options: { channels: [consoleChannel()] } },
  },
});

// 3. Start (binds admin port, installs signal handlers)
const handle = startWorker(ctx);
```

## Three-phase startup

| Phase | Function | What it does |
|-------|----------|--------------|
| 1. Parse | `parseWorkerConfig()` | Validates env vars, returns typed config |
| 2. Build | `createWorkerContext()` | Creates metrics, registers machines, calls `DBOS.launch()`, creates admin server |
| 3. Run | `startWorker()` | Binds admin port, installs `SIGTERM`/`SIGINT` handlers, returns shutdown handle |

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

## Metrics

When the admin server is enabled, the following Prometheus histograms are recorded during startup:

| Metric | Labels | Description |
|--------|--------|-------------|
| `worker_machine_registration_duration_seconds` | `machine_id` | Time to register each machine (validate + DBOS workflow setup) |
| `worker_dbos_launch_duration_seconds` | *(none)* | Time for `DBOS.launch()` (DB connection + workflow recovery) |

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
4. `DBOS.shutdown()` is called
5. Process exits

## API

### `parseWorkerConfig(env?)`

Parses and validates worker configuration from environment variables. Throws on invalid input.

### `createWorkerContext(config, options)`

Registers all machines via `createDurableMachine()`, calls `DBOS.launch()`, and optionally creates the admin server. Returns a `WorkerContext` with typed access to each registered `DurableMachine`.

### `startWorker(ctx)`

Binds the admin server and installs signal handlers. Returns a `WorkerHandle` with a `shutdown()` method for programmatic shutdown.

### `createAdminServer(options?)`

Lower-level: creates the HTTP server without binding a port. Useful when composing with other servers.

### `createWorkerMetrics(registry?)`

Creates a `WorkerMetrics` object with both startup histograms registered on the given (or new) `Registry`.

## License

MIT
