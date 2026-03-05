# Plan: Persist State Only at Durable State Boundaries

## Status: Done

Implemented in commit `8374244` — state persistence is now deferred to boundary points (before recv, before/after invocation, at loop exit). Transitions accumulate in-memory and flush at the same boundaries.

## Problem

`machine-loop.ts` called `DBOS.setEvent("xstate.state", ...)` on **every** iteration of the main loop, including after transient transitions that immediately continue. For a machine with a chain of 5 transient states before reaching a durable wait, that's 5 DB writes where only the last one matters — the intermediate snapshots are never read by anything.

Similarly, `xstate.transitions` was re-written as a full array on every transition, growing the payload size with each append.

## Solution

1. **Deferred state persistence** — `setEvent("xstate.state", ...)` is called only when:
   - The machine reaches a durable state (about to `recv`)
   - An invocation is about to execute (crash recovery needs pre-invocation state)
   - An invocation returns (post-invocation state)
   - The machine reaches a final state (`status === "done"`)

2. **Batched transition records** — transitions accumulate in-memory and flush once at the same boundaries as state persistence, instead of after every transition.

3. **Combine state + transitions into a single `setEvent`** — not implemented (optional). DBOS `setEvent` writes to different keys, so combining requires an upstream SDK change.

## Impact

- Machines with N transient transitions before a durable state go from N writes to 1
- Transition history goes from N full-array rewrites to 1
- No behavioral change — external observers only read state at durable points anyway (the machine is in a transient state for microseconds)
