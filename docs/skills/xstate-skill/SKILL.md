---
name: xstate
description: Use this skill whenever the user wants to build, debug, or reason about state machines, statecharts, or actor-based logic using XState v5. This includes creating state machines with createMachine or setup(), modeling UI flows (forms, wizards, toggles, authentication), orchestrating async work (fetching data, retries, polling), spawning or invoking child actors, using XState with React/Vue/Svelte/Solid, persisting and restoring state, writing XState TypeScript types, migrating from XState v4 to v5, or debugging actor systems. Trigger this skill even for tangential mentions — if the user says "state machine," "statechart," "XState," "actor model," "finite state," "invoke," "spawn," "assign," "createMachine," or discusses modeling complex UI logic with explicit states and transitions, use this skill. Also use when the user asks to visualize or reason about application state flows.
---

# XState v5 Skill

XState is a zero-dependency state management and orchestration library for JavaScript/TypeScript using state machines, statecharts, and the actor model. This skill covers XState v5 exclusively.

**Reference files** (read as needed — do NOT load all at once):
- `references/api-reference.md` — Full API: setup, createMachine, actions, guards, actors, transitions, context, states, persistence, pure transitions, events, delays
- `references/patterns.md` — Common recipes: fetch, wizard, retry, auth, dynamic actors, parallel orchestration, human-in-the-loop
- `references/frameworks.md` — React, Vue, Svelte, Solid integration with hooks and best practices
- `references/typescript.md` — Type setup, type helpers, assertEvent, dynamic params, typed actors

## When to Read References

| User wants to... | Read |
|---|---|
| Build a machine from scratch | This file (continue below) |
| Use a specific API (sendTo, enqueueActions, fromCallback, etc.) | `references/api-reference.md` |
| See a pattern (fetch, retry, wizard, auth, polling) | `references/patterns.md` |
| Use XState with React/Vue/Svelte/Solid | `references/frameworks.md` |
| Set up TypeScript types, use type helpers | `references/typescript.md` |

---

## Installation

```bash
npm install xstate                # Core library
npm install @xstate/react         # React bindings (if needed)
npm install @xstate/vue           # Vue bindings (if needed)
npm install @xstate/svelte        # Svelte bindings (if needed)
npm install @xstate/solid         # Solid bindings (if needed)
```

Requires **TypeScript 5.0+** for full type inference. Works with all bundlers.

---

## Essential Mental Model

1. **Machines** define behavior: states, events, transitions, actions, guards.
2. **Actors** are live instances of machines (or promises, callbacks, observables, transition functions).
3. **Events** are objects with `{ type: string, ...payload }` — always objects, never strings.
4. **Context** is the machine's extended data (like React state). Immutable — update only via `assign()`.
5. **Snapshots** are the current state of an actor: `actor.getSnapshot()` returns `{ value, context, status, output, error, ... }`.
6. **Transitions are synchronous and instantaneous.** Actions are fire-and-forget. Async work belongs in invoked/spawned actors.

---

## The Standard Machine Template

Use `setup()` + `createMachine()` for every non-trivial machine. This is the recommended pattern:

```ts
import { setup, assign, fromPromise, createActor } from 'xstate';

const machine = setup({
  types: {
    context: {} as {
      count: number;
      data: string | null;
      error: string | null;
    },
    events: {} as
      | { type: 'increment' }
      | { type: 'fetch' }
      | { type: 'reset' },
    input: {} as { initialCount: number },
  },
  actions: {
    logCount: ({ context }) => console.log(context.count),
  },
  guards: {
    isPositive: ({ context }) => context.count > 0,
  },
  actors: {
    fetchData: fromPromise(async ({ input }: { input: { id: string } }) => {
      const res = await fetch(`/api/data/${input.id}`);
      if (!res.ok) throw new Error('Failed');
      return res.json();
    }),
  },
  delays: {
    debounce: 300,
  },
}).createMachine({
  id: 'example',
  context: ({ input }) => ({
    count: input.initialCount,
    data: null,
    error: null,
  }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        increment: {
          guard: 'isPositive',
          actions: [
            assign({ count: ({ context }) => context.count + 1 }),
            'logCount',
          ],
        },
        fetch: 'loading',
        reset: {
          actions: assign({ count: 0, data: null, error: null }),
        },
      },
    },
    loading: {
      invoke: {
        src: 'fetchData',
        input: ({ context }) => ({ id: String(context.count) }),
        onDone: {
          target: 'idle',
          actions: assign({ data: ({ event }) => event.output }),
        },
        onError: {
          target: 'idle',
          actions: assign({ error: ({ event }) => String(event.error) }),
        },
      },
    },
  },
});

// Create and run an actor
const actor = createActor(machine, { input: { initialCount: 5 } });
actor.subscribe((snapshot) => {
  console.log(snapshot.value, snapshot.context);
});
actor.start();
actor.send({ type: 'increment' });
actor.send({ type: 'fetch' });
```

---

## Key Concepts Cheatsheet

### States

```ts
states: {
  idle: {},                                // Simple state
  loading: { tags: ['busy'] },             // Tagged state
  editing: {                               // Parent (compound) state
    initial: 'draft',
    states: {
      draft: {},
      review: {},
    },
  },
  player: {                                // Parallel state
    type: 'parallel',
    states: {
      audio: { initial: 'off', states: { off: {}, on: {} } },
      video: { initial: 'off', states: { off: {}, on: {} } },
    },
  },
  done: { type: 'final' },                // Final state
  hist: { type: 'history' },              // Shallow history
  deepHist: { type: 'history', history: 'deep' }, // Deep history
}
```

### Transitions

```ts
on: {
  click: 'active',                          // Shorthand target
  submit: {                                 // Full transition object
    target: 'submitting',
    guard: 'isValid',
    actions: 'logSubmit',
  },
  resolve: [                                // Guarded transitions (first match wins)
    { guard: 'isAdmin', target: 'admin' },
    { target: 'user' },                     // Default
  ],
  update: {                                 // Targetless (stays in current state)
    actions: assign({ count: ({ context }) => context.count + 1 }),
  },
}
```

### Delayed Transitions

```ts
states: {
  waiting: {
    after: {
      3000: 'timedOut',                     // Fixed delay (ms)
      retryDelay: 'retrying',               // Named delay from setup
    },
  },
}
```

### Eventless (Always) Transitions

```ts
states: {
  checking: {
    always: [
      { guard: 'isValid', target: 'valid' },
      { target: 'invalid' },
    ],
  },
}
```

### Context Updates

```ts
// ALWAYS use assign() — never mutate context directly
actions: assign({
  count: ({ context }) => context.count + 1,     // Update one field
  lastEvent: ({ event }) => event.type,
}),

// Or return full context
actions: assign(({ context, event }) => ({
  ...context,
  count: context.count + 1,
})),
```

### Input and Output

```ts
// Input: provided when creating actor
context: ({ input }) => ({ userId: input.userId, data: null }),

// Output: produced when machine reaches final state
output: ({ context }) => ({ result: context.processedData }),
```

---

## Invoked vs Spawned Actors

**Invoke** — tied to a state's lifecycle. Started on entry, stopped on exit.
```ts
loading: {
  invoke: {
    src: 'fetchData',
    input: ({ context }) => ({ url: context.url }),
    onDone: { target: 'success', actions: assign({ data: ({ event }) => event.output }) },
    onError: { target: 'error' },
  },
}
```

**Spawn** — persists across state transitions. Must be explicitly stopped.
```ts
entry: assign({
  workerRef: ({ spawn }) => spawn('workerLogic', { id: 'worker-1' }),
}),
// Or fire-and-forget: entry: spawnChild('workerLogic', { id: 'w1' }),
```

**Use invoke** when: async operation is tied to a state (fetch while loading, poll while connected).
**Use spawn** when: actor must survive state changes (WebSocket, long-lived child, dynamic list of actors).

### Actor Logic Creators

| Creator | Use For |
|---|---|
| `fromPromise(fn)` | One-shot async work (API calls, file reads) |
| `fromCallback(fn)` | Event-driven bidirectional I/O (WebSockets, intervals, DOM listeners) |
| `fromObservable(fn)` | RxJS-style streams |
| `fromEventObservable(fn)` | Observable of event objects forwarded to parent |
| `fromTransition(fn, init)` | Reducer-style logic (like Redux) |
| `createMachine(...)` | Child state machine |

---

## machine.provide() — Swap Implementations

Override named actions, guards, actors, delays at runtime. Essential for testing:

```ts
const testMachine = machine.provide({
  actors: { fetchData: fromPromise(async () => ({ name: 'Mock' })) },
  actions: { logCount: () => {} },
});
```

Only string-referenced implementations can be overridden. Inline functions cannot.

---

## Persistence

```ts
// Save
const persisted = actor.getPersistedSnapshot();
const json = JSON.stringify(persisted);

// Restore
const restored = JSON.parse(json);
const restoredActor = createActor(machine, { snapshot: restored }).start();
```

Persistence is deep — child actors are recursively persisted/restored. On restore, entry actions do NOT re-fire, but invocations restart.

---

## Critical v5 Gotchas

1. **Always use `fromPromise()` for async invoke src.** Never `src: async () => {}`. You'll get `getInitialSnapshot is not a function`.

2. **Events must be objects.** `actor.send('click')` is invalid. Use `actor.send({ type: 'click' })`.

3. **Transitions are internal by default.** Entry/exit actions don't re-fire unless you add `reenter: true`.

4. **Actions are synchronous fire-and-forget.** Async actions are NOT awaited. Use `invoke`/`spawn` with `fromPromise` for async work.

5. **Never mutate context.** Always use `assign()`. Mutation causes bugs with shared refs and persistence.

6. **`send()` is removed in v5.** Use `raise()` (self) or `sendTo()` (other actor). Use `sendParent()` for parent.

7. **`cond` → `guard`.** The v4 `cond` property is now `guard` in v5.

8. **`interpret()` → `createActor()`.** And `machine.withConfig()` → `machine.provide()`.

9. **Child states re-enter when targeted from parent.** Use `stateIn()` guard to prevent unwanted re-entry.

10. **`getNextSnapshot`/`getInitialSnapshot` are deprecated.** Use `transition()` and `initialTransition()` for pure transitions.

---

## When Generating XState Code

Follow this workflow:

1. **Identify the states.** List all the discrete modes/phases.
2. **Identify the events.** List what can happen in each state.
3. **Map transitions.** For each (state, event) pair, determine the target state.
4. **Identify context.** What data needs to persist across states?
5. **Identify side effects.** What actions fire on transitions, entry, exit?
6. **Identify async work.** What needs invoke/spawn?
7. **Use `setup()` + `createMachine()`.** Always. Declare types, actions, guards, actors, delays in setup.
8. **Use named implementations.** Prefer string references for testability via `provide()`.
9. **Add input/output.** Parameterize the machine and declare its output.
10. **Test with pure transitions** or `createActor` + `waitFor`.
