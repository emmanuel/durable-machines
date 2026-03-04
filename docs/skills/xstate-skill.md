# XState v5 — Development Skill Guide

> Authoritative reference for building applications with XState v5.
> Covers the full API surface, actor model, state machine patterns, TypeScript integration, and framework usage.
> Based on XState v5.x (current as of early 2026).

---

## What XState Is

XState is a state management and orchestration library for JavaScript and TypeScript. It uses event-driven programming, state machines, statecharts, and the actor model to handle complex logic in predictable, robust, and visual ways. XState has zero dependencies and works in frontend, backend, or anywhere JavaScript runs.

In XState v5, **actors are the main unit of abstraction**. State machines are one way to define an actor's behavior (and arguably the most robust way), but XState also supports promises, callbacks, observables, and transition functions as actor logic. The library orchestrates these different kinds of logic through a unified event-driven actor system.

**Key properties:**
- Zero dependencies
- Works with React, Vue, Svelte, Solid, Angular, or no framework at all
- TypeScript-first with deep type inference (requires TypeScript 5.0+)
- Visual: machines can be visualized and edited in Stately Studio
- Serializable: state can be persisted and restored

---

## Installation

```bash
npm install xstate
```

Framework integrations (install alongside `xstate`):

| Package | Framework |
|---|---|
| `@xstate/react` | React |
| `@xstate/vue` | Vue |
| `@xstate/svelte` | Svelte |
| `@xstate/solid` | Solid |
| `@xstate/store` | Lightweight store (no state machines) |
| `@statelyai/inspect` | Inspection / debugging |

---

## Core Concepts

### State Machines

A state machine describes behavior as a finite set of **states**, **events** that trigger **transitions** between those states, and **actions** that execute as side effects. A machine can only be in one state at a time (or one combination of states in parallel regions).

### Statecharts

Statecharts extend state machines with hierarchy (nested states), concurrency (parallel states), history, and communication (send/receive). XState implements the full statechart formalism.

### Actors

An actor is a "live" instance of some logic. Actors:
- Have their own private internal state
- Can receive events
- Can send events to other actors
- Can create (spawn) other actors

When you call `createActor(machine).start()`, the machine becomes a running actor. Actors communicate exclusively through asynchronous message passing (events).

### Snapshots

A snapshot is the current state of an actor at a point in time. For a machine actor, the snapshot includes the current state value, context, child actors, status, output, and error. You read a snapshot via `actor.getSnapshot()` or subscribe via `actor.subscribe(observer)`.

---

## The `setup()` + `createMachine()` Pattern

The recommended way to create machines in v5. `setup()` provides strong typing and declares all implementations upfront. `createMachine()` (chained off `setup()`) defines the machine's structure.

```ts
import { setup, assign, fromPromise } from 'xstate';

const machine = setup({
  types: {
    context: {} as { count: number; userId: string },
    events: {} as
      | { type: 'increment' }
      | { type: 'decrement' }
      | { type: 'set'; value: number },
    input: {} as { userId: string },
  },
  actions: {
    logCount: ({ context }) => {
      console.log(`Count: ${context.count}`);
    },
  },
  guards: {
    isPositive: ({ context }) => context.count > 0,
  },
  actors: {
    fetchUser: fromPromise(async ({ input }: { input: { userId: string } }) => {
      const res = await fetch(`/api/users/${input.userId}`);
      return res.json();
    }),
  },
  delays: {
    debounceTimeout: 300,
  },
}).createMachine({
  id: 'counter',
  context: ({ input }) => ({
    count: 0,
    userId: input.userId,
  }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        increment: {
          actions: assign({ count: ({ context }) => context.count + 1 }),
        },
        decrement: {
          guard: 'isPositive',
          actions: assign({ count: ({ context }) => context.count - 1 }),
        },
        set: {
          actions: assign({ count: ({ event }) => event.value }),
        },
      },
    },
  },
});
```

### Why `setup()` matters

- Provides full TypeScript inference for context, events, actions, guards, actors, and delays throughout the machine config.
- Declares all named implementations in one place; the machine config references them by string name.
- Enables `machine.provide()` to swap implementations for testing or different environments.
- Creates type-bound action helpers via `setup.assign()`, `setup.raise()`, `setup.emit()`, `setup.log()`, and `setup.createAction()`.

### `createMachine()` without `setup()`

You can also use `createMachine()` directly with inline implementations. This is simpler for small machines but loses some type inference and reusability.

```ts
import { createMachine, assign } from 'xstate';

const toggleMachine = createMachine({
  id: 'toggle',
  initial: 'inactive',
  states: {
    inactive: { on: { toggle: 'active' } },
    active: { on: { toggle: 'inactive' } },
  },
});
```

---

## Creating and Running Actors

```ts
import { createActor } from 'xstate';

// Create an actor from machine logic
const actor = createActor(machine, {
  input: { userId: 'user-123' },  // Passed to context factory
  // snapshot: persistedState,     // Restore from persisted state
  // systemId: 'mySystem',        // Custom system ID
});

// Subscribe to state changes
actor.subscribe((snapshot) => {
  console.log('State:', snapshot.value);
  console.log('Context:', snapshot.context);
});

// Subscribe to errors
actor.subscribe({
  next: (snapshot) => { /* ... */ },
  error: (err) => { console.error(err); },
});

// Start the actor
actor.start();

// Send events
actor.send({ type: 'increment' });
actor.send({ type: 'set', value: 42 });

// Read current state synchronously
const snapshot = actor.getSnapshot();
console.log(snapshot.value);     // Current state value
console.log(snapshot.context);   // Current context
console.log(snapshot.status);    // 'active', 'done', 'error', 'stopped'
console.log(snapshot.output);    // Final output (if done)
console.log(snapshot.error);     // Error (if errored)

// Check if an event would cause a transition
snapshot.can({ type: 'increment' });  // true/false

// Match state values
snapshot.matches('idle');              // boolean
snapshot.matches({ editing: 'draft' }); // nested state match

// Check tags
snapshot.hasTag('loading');            // boolean

// Stop the actor
actor.stop();
```

---

## States

### Initial States

Every machine must declare an `initial` state (unless it's a parallel state or has no child states).

```ts
createMachine({
  initial: 'idle',
  states: {
    idle: { /* ... */ },
    active: { /* ... */ },
  },
});
```

### Finite States

States are the nodes of the machine. A state can have:
- `on`: event handlers (transitions)
- `entry`: actions run when entering the state
- `exit`: actions run when leaving the state
- `after`: delayed transitions
- `always`: eventless (conditional) transitions
- `invoke`: invoked actors
- `tags`: string tags for grouping/querying
- `meta`: arbitrary metadata
- `states`: child states (making this a parent state)

### Parent (Compound) States

States can be nested. A parent state has child states, and the machine is always in exactly one child state of each active parent.

```ts
states: {
  editing: {
    initial: 'draft',
    states: {
      draft: {
        on: { submit: 'review' },
      },
      review: {
        on: {
          approve: '#published',  // ID-based target (absolute)
          reject: 'draft',        // Relative target (sibling)
        },
      },
    },
  },
  published: {
    id: 'published',
    type: 'final',
  },
}
```

### Parallel States

A parallel state has multiple child regions that are all active simultaneously. Declare with `type: 'parallel'`.

```ts
states: {
  player: {
    type: 'parallel',
    states: {
      playback: {
        initial: 'paused',
        states: {
          paused: { on: { play: 'playing' } },
          playing: { on: { pause: 'paused' } },
        },
      },
      volume: {
        initial: 'normal',
        states: {
          muted: { on: { unmute: 'normal' } },
          normal: { on: { mute: 'muted' } },
        },
      },
    },
  },
}
```

For parallel states, the state value is an object: `{ playback: 'playing', volume: 'muted' }`.

**onDone:** A parallel state's `onDone` transition fires when ALL regions reach their final states.

### Final States

A final state (`type: 'final'`) indicates the machine (or parent state) has completed. When a final state is reached:
- The machine's `status` becomes `'done'`
- The machine produces `output`
- The parent state's `onDone` event fires
- An invoked machine actor sends a `done` event to its parent

```ts
states: {
  success: {
    type: 'final',
  },
},
output: ({ context }) => ({ result: context.data }),
```

### History States

A history state remembers the last active child state. When a transition targets a history state, the machine re-enters the remembered child state instead of the initial state.

```ts
states: {
  editing: {
    initial: 'text',
    states: {
      text: { /* ... */ },
      image: { /* ... */ },
      hist: { type: 'history', history: 'shallow' },
      // history: 'deep' for deep history (remembers nested states too)
    },
  },
  settings: {
    on: {
      back: 'editing.hist',  // Returns to last active child of editing
    },
  },
}
```

---

## Events and Transitions

### Event Objects

Events are plain objects with a `type` string and optional payload properties:

```ts
actor.send({ type: 'feedback.update', feedback: 'Great!', rating: 5 });
```

Convention: use dot-separated namespacing for event types (e.g., `'user.login'`, `'form.submit'`).

### Transition Syntax

```ts
on: {
  // Shorthand: string target only
  click: 'active',

  // Full object: target + actions + guard
  submit: {
    target: 'submitting',
    guard: 'isValid',
    actions: 'logSubmit',
  },

  // Multiple guarded transitions (evaluated in order; first matching wins)
  resolve: [
    { guard: 'isAdmin', target: 'adminPanel' },
    { guard: 'isUser', target: 'dashboard' },
    { target: 'landing' },  // Default (no guard)
  ],
}
```

### Self-Transitions

A targetless transition executes actions without changing state (preserves child states):

```ts
on: {
  increment: {
    // No target — stays in current state, children preserved
    actions: assign({ count: ({ context }) => context.count + 1 }),
  },
}
```

A self-transition **with** an explicit target re-enters the state (resets children, re-runs entry/exit):

```ts
on: {
  reset: {
    target: 'editing',  // Re-enters editing, children reset to initial
    reenter: true,       // Required in v5 for re-entry behavior
  },
}
```

**v5 change:** All transitions are internal by default. Use `reenter: true` to get the v4 "external transition" behavior.

### Eventless (Always) Transitions

Transitions that are evaluated immediately when the state is entered, without an event. Useful for conditional routing:

```ts
states: {
  checking: {
    always: [
      { guard: 'isAuthorized', target: 'authorized' },
      { target: 'unauthorized' },
    ],
  },
}
```

### Wildcard Transitions

The `*` event matches any event not handled by other transitions:

```ts
on: {
  known: { target: 'handled' },
  '*': { actions: 'logUnhandled' },
}
```

---

## Context

Context is the machine's extended (quantitative) state — the data that varies continuously, as opposed to the finite state which is categorical. Context is **immutable** and can only be updated via `assign()`.

### Initial Context

```ts
// Static
context: { count: 0, name: 'World' },

// Lazy (evaluated per actor instance)
context: () => ({ count: 0, createdAt: Date.now() }),

// From input (most common in v5)
context: ({ input }) => ({
  userId: input.userId,
  data: null,
}),
```

### Updating Context with `assign()`

```ts
import { assign } from 'xstate';

// Object syntax: each key is a property to update
actions: assign({
  count: ({ context }) => context.count + 1,
  lastEvent: ({ event }) => event.type,
}),

// Function syntax: return the entire new context
actions: assign(({ context, event }) => ({
  ...context,
  count: context.count + 1,
})),
```

**Never mutate context directly.** Always use `assign()` to produce a new immutable context object.

---

## Input and Output

### Input

Input is data provided to an actor when it is created. Use it to parameterize machines without hardcoding initial context:

```ts
const machine = setup({
  types: {
    input: {} as { userId: string; maxRetries: number },
    context: {} as { userId: string; maxRetries: number; attempts: number },
  },
}).createMachine({
  context: ({ input }) => ({
    userId: input.userId,
    maxRetries: input.maxRetries,
    attempts: 0,
  }),
  // ...
});

const actor = createActor(machine, {
  input: { userId: 'abc', maxRetries: 3 },
});
```

Input is also available for invoked/spawned actors via the `input` property on `invoke` or `spawnChild`.

### Output

Output is the final data produced by a machine actor when it reaches a final state:

```ts
createMachine({
  // ...
  states: {
    done: { type: 'final' },
  },
  output: ({ context }) => ({
    result: context.processedData,
    totalTime: context.elapsed,
  }),
});
```

The output is available on `snapshot.output` and on the `onDone` event (`event.output`) of a parent invoking this machine.

---

## Actions

Actions are side effects that execute during transitions. They are "fire-and-forget" — the machine does not wait for them to complete.

### Where Actions Run

- `entry`: When entering a state
- `exit`: When leaving a state
- Transition `actions`: During a transition (between exit and entry)

### Built-in Action Creators

| Action | Purpose |
|---|---|
| `assign({ ... })` | Update context immutably |
| `raise({ type: '...' })` | Put an event on the internal queue (processed in the same macrostep) |
| `sendTo(actorRef, event)` | Send an event to another actor |
| `sendParent(event)` | Send an event to the parent actor |
| `emit(event)` | Emit an event to external subscribers (via `actor.on(type, handler)`) |
| `log(expr)` | Log a value |
| `spawnChild(logic, options)` | Spawn a child actor |
| `stopChild(actorRefOrId)` | Stop a child actor |
| `cancel(sendId)` | Cancel a delayed `raise` or `sendTo` |
| `enqueueActions(fn)` | Conditionally enqueue multiple actions |

### Inline vs Named Actions

```ts
// Inline (anonymous)
entry: assign({ count: ({ context }) => context.count + 1 }),

// Named (referenced by string, defined in setup or provide)
entry: 'incrementCount',

// Object with params (named + dynamic parameters)
entry: {
  type: 'greet',
  params: ({ context }) => ({ name: context.userName }),
},
```

### `enqueueActions()` — Conditional / Dynamic Actions

Replaces v4's `choose()` and `pure()`. Allows imperative conditional logic for enqueueing actions:

```ts
import { enqueueActions } from 'xstate';

entry: enqueueActions(({ context, event, enqueue, check }) => {
  enqueue.assign({ count: context.count + 1 });

  if (check('isAdmin')) {
    enqueue('notifyAdmin');
    enqueue.sendTo('logger', { type: 'log', message: 'Admin action' });
  }

  if (event.type === 'reset') {
    enqueue.raise({ type: 'restart' });
  }
}),
```

### Dynamic Parameters (Recommended over `assertEvent`)

Use `params` to decouple action implementations from specific events:

```ts
setup({
  actions: {
    greet: (_, params: { name: string }) => {
      console.log(`Hello, ${params.name}!`);
    },
  },
}).createMachine({
  entry: {
    type: 'greet',
    params: ({ context }) => ({ name: context.user.name }),
  },
});
```

---

## Guards

Guards are boolean conditions that determine if a transition is enabled. They must be **pure functions** (no side effects).

```ts
setup({
  guards: {
    isValid: ({ context }) => context.feedback.length > 0,
    hasPermission: ({ context }, params: { role: string }) =>
      context.user.roles.includes(params.role),
  },
}).createMachine({
  on: {
    submit: {
      guard: 'isValid',
      target: 'submitting',
    },
    adminAction: {
      guard: { type: 'hasPermission', params: { role: 'admin' } },
      target: 'adminPanel',
    },
  },
});
```

### Higher-Order Guards

Combine guards with `and()`, `or()`, `not()`:

```ts
import { and, or, not } from 'xstate';

on: {
  submit: {
    guard: and(['isValid', not('isSubmitting')]),
    target: 'submitting',
  },
  access: {
    guard: or(['isAdmin', and(['isUser', 'hasVerifiedEmail'])]),
    target: 'dashboard',
  },
}
```

### `stateIn()` Guard

Check if a parallel region is in a specific state:

```ts
import { stateIn } from 'xstate';

guard: stateIn({ audio: 'playing' }),
```

---

## Delayed (After) Transitions

Transitions that fire after a specified time interval. The timer is automatically cancelled when the state is exited.

```ts
states: {
  waiting: {
    after: {
      // Inline delay (milliseconds)
      3000: { target: 'timedOut' },

      // Named delay (referenced from setup)
      retryDelay: {
        target: 'retrying',
        actions: 'incrementAttempt',
      },
    },
  },
}
```

### Dynamic Delays

```ts
setup({
  delays: {
    retryDelay: ({ context }) =>
      Math.min(1000 * Math.pow(2, context.attempt), 30000),
  },
});
```

---

## Invoked Actors

An **invoked** actor is started when a state is entered and stopped when the state is exited. Use `invoke` to run async operations, child machines, or any actor logic tied to a state's lifecycle.

```ts
states: {
  loading: {
    invoke: {
      id: 'fetchData',
      src: 'fetchUser',              // References actor from setup
      input: ({ context }) => ({
        userId: context.userId,
      }),
      onDone: {
        target: 'success',
        actions: assign({
          data: ({ event }) => event.output,
        }),
      },
      onError: {
        target: 'failure',
        actions: assign({
          error: ({ event }) => event.error,
        }),
      },
    },
  },
}
```

### Actor Logic Creators

| Creator | Description | Completes? |
|---|---|---|
| `fromPromise(fn)` | Async function → resolves/rejects | Yes |
| `fromCallback(fn)` | Callback-based: can send/receive events | When `sendBack` fires no more |
| `fromObservable(fn)` | RxJS-style observable stream | When complete/error |
| `fromEventObservable(fn)` | Observable of event objects (forwarded to parent) | When complete/error |
| `fromTransition(fn, init)` | Reducer-style transition function | No (long-lived) |
| `createMachine(...)` | Another state machine | When final state reached |

### `fromPromise` Example

```ts
import { fromPromise, setup } from 'xstate';

const fetchUser = fromPromise(async ({ input }: { input: { userId: string } }) => {
  const response = await fetch(`/api/users/${input.userId}`);
  if (!response.ok) throw new Error('Fetch failed');
  return response.json();
});

const machine = setup({
  actors: { fetchUser },
}).createMachine({
  states: {
    loading: {
      invoke: {
        src: 'fetchUser',
        input: ({ context }) => ({ userId: context.userId }),
        onDone: { target: 'done', actions: assign({ user: ({ event }) => event.output }) },
        onError: { target: 'error' },
      },
    },
  },
});
```

### `fromCallback` Example

```ts
import { fromCallback } from 'xstate';

const listenToSocket = fromCallback(({ sendBack, receive, input }) => {
  const ws = new WebSocket(input.url);

  ws.onmessage = (event) => {
    sendBack({ type: 'message', data: JSON.parse(event.data) });
  };

  // Receive events from parent
  receive((event) => {
    if (event.type === 'send') {
      ws.send(JSON.stringify(event.data));
    }
  });

  // Return cleanup function
  return () => ws.close();
});
```

### Invoking Child Machines

```ts
const childMachine = setup({ /* ... */ }).createMachine({ /* ... */ });

const parentMachine = setup({
  actors: { childMachine },
}).createMachine({
  states: {
    active: {
      invoke: {
        id: 'child',
        src: 'childMachine',
        input: ({ context }) => ({ parentData: context.data }),
        onDone: {
          target: 'complete',
          actions: assign({ result: ({ event }) => event.output }),
        },
      },
    },
  },
});
```

### Multiple Invocations

A state can invoke multiple actors:

```ts
invoke: [
  { id: 'fetchUser', src: 'fetchUser', /* ... */ },
  { id: 'fetchPosts', src: 'fetchPosts', /* ... */ },
],
```

---

## Spawned Actors

**Spawning** creates a child actor that persists across states (unlike invoked actors, which are tied to a single state).

```ts
import { spawnChild, stopChild, sendTo } from 'xstate';

// Method 1: spawnChild action (fire-and-forget, no ref in context)
entry: spawnChild('someActorLogic', { id: 'worker-1' }),

// Method 2: spawn inside assign (store ref in context)
entry: assign({
  workerRef: ({ spawn }) => spawn('someActorLogic', { id: 'worker-1' }),
}),

// Send events to spawned actor
on: {
  sendToWorker: {
    actions: sendTo('worker-1', { type: 'doWork' }),
    // or: sendTo(({ context }) => context.workerRef, event)
  },
},

// Stop a spawned actor
on: {
  stopWorker: {
    actions: stopChild('worker-1'),
    // or: stopChild(({ context }) => context.workerRef),
  },
},
```

**When to invoke vs spawn:**
- **Invoke** when the actor's lifecycle matches a state's lifecycle (e.g., fetch data while in "loading" state).
- **Spawn** when the actor needs to survive state transitions (e.g., a WebSocket connection that stays open across multiple states, or dynamic lists of child actors).

---

## `machine.provide()` — Dependency Injection

Replace implementations without changing the machine structure. Essential for testing and runtime configuration:

```ts
const machine = setup({
  actions: {
    sendEmail: () => { /* production implementation */ },
  },
  actors: {
    fetchData: fromPromise(async () => { /* production */ }),
  },
}).createMachine({ /* ... */ });

// For testing:
const testMachine = machine.provide({
  actions: {
    sendEmail: () => { /* mock: do nothing */ },
  },
  actors: {
    fetchData: fromPromise(async () => ({ name: 'Test User' })),
  },
});

const actor = createActor(testMachine).start();
```

Only named implementations (strings) can be overridden via `provide()`. Inline functions cannot be replaced.

---

## Persistence and Restoration

XState actors can serialize their state for persistence (localStorage, database, etc.) and restore it later.

```ts
// Persist
const actor = createActor(machine).start();
// ... some time later ...
const persistedState = actor.getPersistedSnapshot();
const serialized = JSON.stringify(persistedState);
// Save `serialized` to storage

// Restore
const restored = JSON.parse(serialized);
const restoredActor = createActor(machine, {
  snapshot: restored,
}).start();
```

**Deep persistence:** For machine actors, `getPersistedSnapshot()` is recursive — all invoked and spawned child actors are also persisted and restored.

**Important:** On restoration, entry actions are **not** re-executed (they are assumed to have already run). However, invocations are restarted.

---

## Pure Transition Functions

For testing or server-side rendering, you can compute transitions without creating actors:

```ts
import { initialTransition, transition } from 'xstate';

const [initialState, initialActions] = initialTransition(machine);
console.log(initialState.value); // 'idle'

const [nextState, actions] = transition(machine, initialState, { type: 'start' });
console.log(nextState.value); // 'running'
console.log(actions);          // [{ type: 'doSomething', ... }]
```

These are pure functions — no actors are created, no side effects are executed. Use `initialTransition()` and `transition()` instead of the deprecated `getInitialSnapshot()` and `getNextSnapshot()`.

---

## Event Emitter

Actors can emit events to external subscribers (outside the actor system). This is useful for analytics, logging, or notifying external systems.

```ts
// In machine setup
setup({
  types: {
    emitted: {} as
      | { type: 'countChanged'; count: number }
      | { type: 'error'; message: string },
  },
}).createMachine({
  on: {
    increment: {
      actions: [
        assign({ count: ({ context }) => context.count + 1 }),
        emit({ type: 'countChanged', count: /* ... */ }),
      ],
    },
  },
});

// External subscriber
actor.on('countChanged', (event) => {
  analytics.track('count_changed', { count: event.count });
});
```

---

## Tags

Tags are string labels on states for semantic grouping. Prefer `hasTag()` over `matches()` — tags are resilient to state restructuring.

```ts
states: {
  loading: {
    tags: ['busy'],
    // ...
  },
  saving: {
    tags: ['busy'],
    // ...
  },
  idle: {
    tags: ['ready'],
  },
}

// Usage
const snapshot = actor.getSnapshot();
if (snapshot.hasTag('busy')) {
  showSpinner();
}
```

---

## Framework Integration

### React (`@xstate/react`)

```tsx
import { useMachine, useActor, useSelector, useActorRef } from '@xstate/react';

function Counter() {
  // Full machine lifecycle
  const [snapshot, send] = useMachine(counterMachine, {
    input: { initialCount: 0 },
  });

  return (
    <div>
      <p>Count: {snapshot.context.count}</p>
      <p>State: {snapshot.value}</p>
      <button onClick={() => send({ type: 'increment' })}>+</button>
      <button
        onClick={() => send({ type: 'decrement' })}
        disabled={!snapshot.can({ type: 'decrement' })}
      >-</button>
    </div>
  );
}

// useSelector for optimized re-renders (only re-renders when selected value changes)
function CountDisplay({ actorRef }) {
  const count = useSelector(actorRef, (snapshot) => snapshot.context.count);
  return <span>{count}</span>;
}

// useActorRef: get a stable actor ref without subscribing to all changes
function Parent() {
  const actorRef = useActorRef(counterMachine);
  return <CountDisplay actorRef={actorRef} />;
}
```

### Vue (`@xstate/vue`)

```vue
<script setup>
import { useMachine } from '@xstate/vue';
import { counterMachine } from './counterMachine';

const { snapshot, send } = useMachine(counterMachine);
</script>

<template>
  <p>Count: {{ snapshot.context.count }}</p>
  <button @click="send({ type: 'increment' })">+</button>
</template>
```

### Svelte (`@xstate/svelte`)

```svelte
<script>
  import { useMachine } from '@xstate/svelte';
  import { counterMachine } from './counterMachine';

  const { snapshot, send } = useMachine(counterMachine);
</script>

<p>Count: {$snapshot.context.count}</p>
<button on:click={() => send({ type: 'increment' })}>+</button>
```

---

## TypeScript

### Type Setup

```ts
const machine = setup({
  types: {
    context: {} as { count: number; user: User | null },
    events: {} as
      | { type: 'increment' }
      | { type: 'setUser'; user: User },
    input: {} as { initialCount: number },
    output: {} as { finalCount: number },
    emitted: {} as { type: 'countChanged'; count: number },
    // For typed children:
    children: {} as { fetcher: 'fetchLogic' },
  },
}).createMachine({ /* ... */ });
```

### Type Helpers

| Helper | Purpose |
|---|---|
| `SnapshotFrom<typeof machine>` | Type of the machine's snapshot |
| `EventFromLogic<typeof machine>` | Union of all event types |
| `ContextFrom<typeof machine>` | Type of the context |
| `ActorRefFrom<typeof machine>` | Type of an actor ref for this machine |
| `InputFrom<typeof machine>` | Type of the input |
| `OutputFrom<typeof machine>` | Type of the output |

### `assertEvent()` for Event Narrowing

When you must access event-specific data in an action where the event type isn't narrowed:

```ts
import { assertEvent } from 'xstate';

actions: ({ event }) => {
  assertEvent(event, 'setUser');
  // event is now narrowed to { type: 'setUser'; user: User }
  console.log(event.user);
},
```

**Prefer dynamic params over assertEvent** when possible — params are more composable and type-safe.

---

## Testing

### Unit Testing (Pure Transitions)

```ts
import { initialTransition, transition } from 'xstate';

test('increments count', () => {
  const [initial] = initialTransition(counterMachine);
  const [next] = transition(counterMachine, initial, { type: 'increment' });
  expect(next.context.count).toBe(1);
});
```

### Integration Testing (With Actors)

```ts
import { createActor } from 'xstate';

test('reaches success state', async () => {
  const actor = createActor(machine).start();
  actor.send({ type: 'fetch' });

  // Wait for a specific condition
  const snapshot = await waitFor(actor, (s) => s.matches('success'), {
    timeout: 5000,
  });
  expect(snapshot.context.data).toBeDefined();
});
```

### Testing with `machine.provide()`

```ts
test('handles fetch error', async () => {
  const testMachine = machine.provide({
    actors: {
      fetchData: fromPromise(async () => { throw new Error('fail'); }),
    },
  });

  const actor = createActor(testMachine).start();
  actor.send({ type: 'fetch' });

  const snapshot = await waitFor(actor, (s) => s.matches('error'));
  expect(snapshot.context.error).toBeDefined();
});
```

---

## Inspection / Debugging

```ts
import { createActor } from 'xstate';

const actor = createActor(machine, {
  inspect: (inspectionEvent) => {
    if (inspectionEvent.type === '@xstate.snapshot') {
      console.log('Snapshot:', inspectionEvent.snapshot);
    }
    if (inspectionEvent.type === '@xstate.event') {
      console.log('Event:', inspectionEvent.event);
    }
    if (inspectionEvent.type === '@xstate.actor') {
      console.log('Actor created:', inspectionEvent.actorRef.id);
    }
  },
});
```

For visual inspection, use `@statelyai/inspect` with Stately Studio.

---

## `@xstate/store` — Lightweight Alternative

For simple state management without the full state machine formalism:

```ts
import { createStore } from '@xstate/store';

const store = createStore({
  context: { count: 0, name: 'World' },
  on: {
    inc: (context, event: { by: number }) => ({
      ...context,
      count: context.count + event.by,
    }),
    changeName: (context, event: { name: string }) => ({
      ...context,
      name: event.name,
    }),
  },
});

store.subscribe((snapshot) => console.log(snapshot.context));
store.send({ type: 'inc', by: 5 });
```

Use `@xstate/store` when you need simple event-driven state updates without states, transitions, invocations, or the full actor model.

---

## Common Patterns

### Fetch / Async Data Pattern

```ts
const fetchMachine = setup({
  actors: {
    fetchData: fromPromise(async ({ input }: { input: { url: string } }) => {
      const res = await fetch(input.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
  },
}).createMachine({
  id: 'fetch',
  initial: 'idle',
  context: ({ input }) => ({ url: input.url, data: null, error: null }),
  states: {
    idle: {
      on: { fetch: 'loading' },
    },
    loading: {
      invoke: {
        src: 'fetchData',
        input: ({ context }) => ({ url: context.url }),
        onDone: {
          target: 'success',
          actions: assign({ data: ({ event }) => event.output }),
        },
        onError: {
          target: 'failure',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
    success: { on: { refresh: 'loading' } },
    failure: { on: { retry: 'loading' } },
  },
});
```

### Multi-Step Form / Wizard

```ts
createMachine({
  initial: 'step1',
  context: { step1Data: null, step2Data: null },
  states: {
    step1: {
      on: {
        next: {
          target: 'step2',
          actions: assign({ step1Data: ({ event }) => event.data }),
        },
      },
    },
    step2: {
      on: {
        back: 'step1',
        next: {
          target: 'step3',
          actions: assign({ step2Data: ({ event }) => event.data }),
        },
      },
    },
    step3: {
      on: { back: 'step2', submit: 'submitting' },
    },
    submitting: {
      invoke: { src: 'submitForm', onDone: 'done', onError: 'step3' },
    },
    done: { type: 'final' },
  },
});
```

### Retry with Exponential Backoff

```ts
createMachine({
  context: { attempts: 0, maxAttempts: 5 },
  initial: 'fetching',
  states: {
    fetching: {
      invoke: {
        src: 'fetchData',
        onDone: 'success',
        onError: [
          { guard: 'canRetry', target: 'waiting' },
          { target: 'failed' },
        ],
      },
    },
    waiting: {
      entry: assign({ attempts: ({ context }) => context.attempts + 1 }),
      after: {
        retryDelay: 'fetching',  // Dynamic delay based on attempts
      },
    },
    success: { type: 'final' },
    failed: { type: 'final' },
  },
});
```

### Authentication State Machine

```ts
createMachine({
  initial: 'idle',
  context: { user: null, error: null },
  states: {
    idle: {
      on: { login: 'authenticating' },
    },
    authenticating: {
      invoke: {
        src: 'authenticate',
        input: ({ event }) => ({ credentials: event.credentials }),
        onDone: {
          target: 'authenticated',
          actions: assign({ user: ({ event }) => event.output }),
        },
        onError: {
          target: 'idle',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
    authenticated: {
      on: {
        logout: {
          target: 'idle',
          actions: assign({ user: null, error: null }),
        },
      },
    },
  },
});
```

---

## Gotchas and Pitfalls

1. **v4 vs v5 syntax confusion.** LLMs and older blog posts frequently generate v4 code. Key differences: v5 uses `setup()`, `guard` (not `cond`), `createActor` (not `interpret`), `machine.provide()` (not `machine.withConfig()`), `fromPromise` for invoke src (not bare async functions), `assign` receives `({ context, event })` (not separate args), and events must be objects (not strings).

2. **`fromPromise` required for async invoke.** Never use `src: async () => { ... }` directly in v5. Always wrap with `fromPromise()`. Without it you get the cryptic `getInitialSnapshot is not a function` error.

3. **Transitions are internal by default.** In v5, transitions do NOT re-enter the current state. If you need entry/exit actions to re-fire, use `reenter: true`.

4. **Child states re-enter when targeted.** If a transition on a parent targets a child state, the child's entry/exit actions WILL fire even if the child was already active. Use `stateIn()` guard to prevent unwanted re-entry.

5. **Actions are synchronous.** Async actions are not awaited. If you need async work, use `invoke` or `spawn` with `fromPromise`/`fromCallback`. Transition execution is always instantaneous.

6. **Context must be immutable.** Never do `context.count++`. Always use `assign()`. Mutating context leads to bugs with shared references across subscribers and persisted snapshots.

7. **Events must be objects with `type`.** Strings are not valid events in v5. Always send `{ type: 'eventName', ...payload }`.

8. **`state.can()` executes guards.** It runs the guard function to check if a transition is enabled. Guards must be pure (no side effects) for this to be safe.

9. **Spawned actors vs invoked actors.** Invoked actors are automatically stopped when their state is exited. Spawned actors persist until explicitly stopped. If you invoke when you mean to spawn (or vice versa), actors will have unexpected lifecycles.

10. **`waitFor` can hang.** In tests, if the condition is never met, `waitFor` will hang until the timeout. Always provide a reasonable `timeout` option and ensure your test sends the events needed to reach the target state.

11. **Bundler-friendly.** Unlike DBOS, XState works fine with all bundlers (Webpack, Vite, Rollup, etc.). It's a pure library with no special runtime requirements.

12. **`getNextSnapshot` / `getInitialSnapshot` are deprecated.** Use `transition()` and `initialTransition()` instead — these return `[state, actions]` tuples and are the recommended pure transition functions.

---

## API Quick Reference

### Top-Level Exports from `xstate`

| Export | Category |
|---|---|
| `createMachine`, `setup` | Machine creation |
| `createActor`, `createEmptyActor` | Actor creation |
| `assign` | Context updates |
| `raise`, `sendTo`, `sendParent`, `emit` | Event actions |
| `log`, `cancel` | Utility actions |
| `spawnChild`, `stopChild` | Child actor management |
| `enqueueActions` | Conditional action composition |
| `fromPromise`, `fromCallback`, `fromObservable`, `fromEventObservable`, `fromTransition` | Actor logic creators |
| `and`, `or`, `not`, `stateIn` | Guard combinators |
| `waitFor`, `toPromise` | Actor utilities |
| `transition`, `initialTransition` | Pure transition functions |
| `getNextSnapshot`, `getInitialSnapshot` | (Deprecated) Pure snapshot functions |
| `assertEvent`, `matchesState` | Type/state utilities |

---

## Links

- **Docs:** https://stately.ai/docs
- **GitHub:** https://github.com/statelyai/xstate
- **npm:** `xstate`
- **Discord:** https://discord.gg/xstate
- **Stately Studio (visual editor):** https://stately.ai/editor
- **Migration guide (v4→v5):** https://stately.ai/docs/migration
- **XState Store:** https://stately.ai/docs/xstate-store
