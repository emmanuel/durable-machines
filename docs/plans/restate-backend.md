# Plan: Restate Backend

## Status: Deferred

No concrete user demand. Revisit if Restate adoption creates pull.

## What @restatedev/xstate covers

The existing `@restatedev/xstate` package (at github.com/restatedev/xstate) already
provides XState-on-Restate with:

- State persistence in K/V store
- Transitions via Virtual Object handlers
- Delay scheduling with UUID-based cancellation (`system.ts`)
- Invocation via shared handlers
- Snapshot reads
- `waitFor` with awakeables
- Versioning support

### Key files in @restatedev/xstate

- `packages/restate-xstate/src/lib/system.ts` — delay scheduler pattern
- `packages/restate-xstate/src/lib/actorObject.ts` — Virtual Object handlers
- `packages/restate-xstate/src/lib/createActor.ts` — actor rehydration from K/V
- `packages/restate-xstate/src/lib/promise.ts` — Restate-aware fromPromise

## What it lacks (what our DurableMachine adds)

- Machine validation (`validateMachineForDurability`)
- Append-only event log (`getEventLog`)
- Effect system (collection, outbox, handlers, `listEffects`)
- Prompt/channel lifecycle (`sendPrompt` / `resolvePrompt`)
- Transition log for visualization
- `listInstances()` / cross-instance queries
- `getSteps()` invocation history
- `cancel()` mid-workflow
- `MachineVisualizationState`
- Worker context (`register` / `start` / `shutdown`)

## If we proceed: fork their patterns (approach #2)

Rather than wrapping `@restatedev/xstate`, build our own Virtual Object handlers with
our features baked in. No runtime dependency on `@restatedev/xstate`.

1. Study their delay scheduling (UUID cancellation in `system.ts`) and actor rehydration
2. Build own Virtual Object handlers using our `DurableMachineStore` interface
3. Use `ctx.run()` for invocations (simpler than their async event-feedback pattern)
4. Map our `DurableMachineStore` to Restate K/V + a Virtual Object index for queries

## Reasons to defer

1. **Narrow audience** — XState + Restate intersection is small
2. **Three-backend maintenance burden** — PG + CF DO + Restate is a lot to maintain
3. **K/V state growth** — no indexed tables, no pagination; listing/querying instances
   requires a separate index Virtual Object (poor substitute for SQL)
4. **Debugging opacity** — RocksDB vs `psql`; harder to inspect state
5. **SDK coupling risk** — Restate SDK still evolving (v1.x); tight coupling risks
   breakage on SDK updates
