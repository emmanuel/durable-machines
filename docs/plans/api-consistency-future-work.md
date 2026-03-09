# API Consistency: Future Work

Deferred improvements identified during the API consistency audit (March 2026).

## Worker runtime metrics

Processing-time histograms, error counters, and active instance gauges. Requires
changes in `durable-machine` machine-loop (event processing, transition timing,
effect execution). The current `worker_backend_start_duration_seconds` only
covers startup.

## Shared admin server package

`gateway/src/admin.ts` and `worker/src/admin.ts` are byte-identical (~42 lines).
Extract to an internal shared package if maintenance burden grows or they need
to diverge. Currently cross-referenced with comments.

## Logger interface for worker

Gateway has an optional structured `Logger` for streams. Worker has no logging.
Define a consistent Logger interface (or adopt pino/winston types) when the
worker needs observability beyond Prometheus metrics.

## Barrel export snapshot tests

`import * from pkg` + `expect(Object.keys(API)).toMatchSnapshot()` to catch
accidental export additions/removals. Valuable for public API stability.

## Gateway shutdown + AppContext integration

`startGateway` has its own shutdown logic (stops streams, drains HTTP, closes
checkpoint pool) that runs independently of `AppContext.shutdown()`. Stream
consumers aren't stopped when AppContext handles a signal. Consider wiring
stream shutdown into the AppContext `backend.stop()` hook.

## Typed machine accessor

After DBOS worker unification, typed machine access (`ctx.machines.approvals`)
is lost in favor of Map access (`ctx.machines.get("approvals")!`). Consider a
type-safe helper like `ctx.machine<T>("approvals")` or a builder that returns
a typed wrapper alongside the Map.
