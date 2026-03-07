# XState v5 API Reference

## Table of Contents

1. [Machine Creation](#machine-creation)
2. [Actor Lifecycle](#actor-lifecycle)
3. [States](#states)
4. [Transitions](#transitions)
5. [Context and assign()](#context-and-assign)
6. [Actions](#actions)
7. [Guards](#guards)
8. [Delayed Transitions](#delayed-transitions)
9. [Invoked Actors](#invoked-actors)
10. [Spawned Actors](#spawned-actors)
11. [Actor Logic Creators](#actor-logic-creators)
12. [Events and Messaging](#events-and-messaging)
13. [Input and Output](#input-and-output)
14. [Persistence](#persistence)
15. [Pure Transition Functions](#pure-transition-functions)
16. [Inspection](#inspection)
17. [Event Emitter](#event-emitter)
18. [Tags and Meta](#tags-and-meta)
19. [Top-Level Exports](#top-level-exports)

---

## Machine Creation

### setup()

Declares types, named implementations, and returns a builder with `.createMachine()`:

```ts
import { setup, assign, fromPromise } from 'xstate';

const machine = setup({
  types: {
    context: {} as { count: number },
    events: {} as { type: 'inc' } | { type: 'dec' } | { type: 'set'; value: number },
    input: {} as { initial: number },
    output: {} as { final: number },
    emitted: {} as { type: 'changed'; count: number },
    children: {} as { fetcher: 'fetchLogic' },
  },
  actions: {
    doSomething: () => { console.log('done'); },
    greet: (_, params: { name: string }) => { console.log(`Hi ${params.name}`); },
  },
  guards: {
    isPositive: ({ context }) => context.count > 0,
    isBelow: ({ context }, params: { max: number }) => context.count < params.max,
  },
  actors: {
    fetchLogic: fromPromise(async ({ input }: { input: { url: string } }) => {
      return fetch(input.url).then(r => r.json());
    }),
  },
  delays: {
    shortTimeout: 1000,
    dynamicDelay: ({ context }) => context.count * 100,
  },
}).createMachine({ /* machine config */ });
```

**setup() also provides type-bound action helpers:**

```ts
const machineSetup = setup({
  types: {
    context: {} as { count: number },
    events: {} as { type: 'inc' } | { type: 'reset' },
    emitted: {} as { type: 'CHANGED' },
  },
});

const increment = machineSetup.assign({ count: ({ context }) => context.count + 1 });
const raiseReset = machineSetup.raise({ type: 'reset' });
const emitChanged = machineSetup.emit({ type: 'CHANGED' });
const logCount = machineSetup.log(({ context }) => `Count: ${context.count}`);
const customAction = machineSetup.createAction(({ context, event }) => {
  console.log(context.count, event.type);
});

const machine = machineSetup.createMachine({
  context: { count: 0 },
  entry: [customAction, increment, emitChanged],
  on: {
    inc: { actions: increment },
    reset: { actions: raiseReset },
  },
});
```

### createMachine()

Creates a machine directly (without setup). Simpler but less type-safe:

```ts
import { createMachine, assign } from 'xstate';

const machine = createMachine({
  id: 'toggle',
  initial: 'inactive',
  context: { count: 0 },
  states: {
    inactive: {
      on: { toggle: 'active' },
    },
    active: {
      entry: assign({ count: ({ context }) => context.count + 1 }),
      on: { toggle: 'inactive' },
    },
  },
});
```

### machine.provide()

Creates a new machine with overridden implementations (immutable — does not modify original):

```ts
const customMachine = machine.provide({
  actions: {
    doSomething: () => { /* different implementation */ },
  },
  guards: {
    isPositive: () => true, // Always allow
  },
  actors: {
    fetchLogic: fromPromise(async () => ({ mock: true })),
  },
  delays: {
    shortTimeout: 5000,
  },
});
```

---

## Actor Lifecycle

### createActor()

```ts
import { createActor } from 'xstate';

const actor = createActor(machine, {
  input: { initial: 5 },      // Passed to context factory
  snapshot: persistedState,    // Restore from persisted snapshot
  systemId: 'myActor',        // ID in the actor system
  inspect: (event) => {},      // Inspection callback
});
```

### actor.start()

Starts the actor. Entry actions fire, invoked actors start:

```ts
actor.start();
```

### actor.send()

Send an event to the actor:

```ts
actor.send({ type: 'increment' });
actor.send({ type: 'set', value: 42 });
// Events MUST be objects with a `type` property. Strings are invalid.
```

### actor.getSnapshot()

Read the current snapshot synchronously:

```ts
const snapshot = actor.getSnapshot();
snapshot.value;      // Current state value (string or object for parallel/nested)
snapshot.context;    // Current context
snapshot.status;     // 'active' | 'done' | 'error' | 'stopped'
snapshot.output;     // Final output (only when status === 'done')
snapshot.error;      // Error (only when status === 'error')
snapshot.children;   // Map of child actor refs
snapshot.can({ type: 'event' });     // Check if transition is enabled
snapshot.matches('stateName');       // Check state value
snapshot.matches({ parent: 'child' });
snapshot.hasTag('loading');          // Check if any active state has tag
snapshot.getMeta();                  // Get meta from all active states
```

### actor.subscribe()

Subscribe to snapshot changes:

```ts
// Simple function
const sub = actor.subscribe((snapshot) => { /* ... */ });

// Observer object (with error handling)
const sub = actor.subscribe({
  next: (snapshot) => { /* ... */ },
  error: (err) => { console.error(err); },
  complete: () => { console.log('Actor done'); },
});

// Unsubscribe
sub.unsubscribe();
```

### actor.stop()

Stop the actor. All child actors are stopped recursively:

```ts
actor.stop();
```

### actor.on()

Listen for emitted events (not state changes — use subscribe for those):

```ts
actor.on('countChanged', (event) => {
  console.log(event.count);
});
```

---

## States

### State Types

| Type | Property | Description |
|---|---|---|
| Normal | (default) | A regular state |
| Initial | `initial: 'stateName'` on parent | First state entered |
| Final | `type: 'final'` | Machine/parent is "done" |
| Parent (Compound) | Has `states: {}` and `initial` | Contains child states |
| Parallel | `type: 'parallel'` | All child regions active simultaneously |
| History (Shallow) | `type: 'history'` | Remembers last active child |
| History (Deep) | `type: 'history', history: 'deep'` | Remembers entire nested state |

### State Node Properties

```ts
stateName: {
  // Transitions
  on: { /* event handlers */ },
  after: { /* delayed transitions */ },
  always: [ /* eventless transitions */ ],

  // Actions
  entry: [ /* actions on enter */ ],
  exit: [ /* actions on exit */ ],

  // Child states
  initial: 'childName',
  states: { /* child state nodes */ },

  // Actors
  invoke: { /* or array of invocations */ },

  // Metadata
  tags: ['loading', 'busy'],
  meta: { description: 'User is editing' },

  // Completion
  type: 'final',

  // History
  type: 'history',
  history: 'shallow', // or 'deep'
  target: 'defaultChild', // fallback if no history
}
```

### State Values

```ts
// Simple: string
'idle'

// Nested (compound): string
'editing'  // (refers to the parent; actual child is tracked internally)

// Parallel: object
{ audio: 'playing', video: 'paused' }

// Nested parallel: nested object
{ player: { audio: 'playing', video: 'paused' }, controls: 'visible' }
```

### onDone (State Completion)

When a final child state is reached, the parent emits a "done" event:

```ts
states: {
  processing: {
    initial: 'step1',
    states: {
      step1: { on: { next: 'step2' } },
      step2: { on: { next: 'done' } },
      done: { type: 'final' },
    },
    onDone: 'complete', // Transition when child reaches final state
  },
  complete: {},
}
```

---

## Transitions

### Event Transitions (on)

```ts
on: {
  // String shorthand (target only)
  click: 'nextState',

  // Object (target + actions + guard)
  submit: {
    target: 'submitting',
    guard: 'isValid',
    actions: 'logSubmit',
    reenter: false,  // default false (internal); true = re-enter state
  },

  // Multiple guarded (first match wins)
  resolve: [
    { guard: 'isAdmin', target: 'adminView', actions: 'logAdmin' },
    { guard: 'isUser', target: 'userView' },
    { target: 'guestView' }, // Default (no guard)
  ],

  // Targetless (no state change, just actions — preserves child states)
  update: {
    actions: assign({ count: ({ context }) => context.count + 1 }),
  },

  // Wildcard (matches any unhandled event)
  '*': { actions: 'logUnhandled' },
}
```

### Targets

```ts
target: 'sibling',              // Sibling state (same parent)
target: '.child',               // Child of current state (relative)
target: '#stateId',             // Absolute by ID
target: 'parent.child',         // Dot path
```

### Reenter

```ts
// v5 default: transitions are internal (no re-entry)
on: {
  refresh: {
    target: 'loading',
    reenter: true,  // Forces exit+entry actions to re-fire
  },
}
```

### Root-Level Transitions

Events handled on the root level apply to all states:

```ts
createMachine({
  on: {
    LOGOUT: '.loggedOut', // Handled from any state
  },
  initial: 'idle',
  states: { /* ... */ },
});
```

---

## Context and assign()

### Initial Context

```ts
// Static
context: { count: 0, name: '' },

// Lazy (per-actor instance)
context: () => ({ count: 0, ts: Date.now() }),

// From input
context: ({ input }) => ({ userId: input.userId, data: null }),
```

### assign()

```ts
import { assign } from 'xstate';

// Object syntax (update specific properties)
assign({
  count: ({ context }) => context.count + 1,
  name: ({ event }) => event.name,
  timestamp: () => Date.now(),
})

// Function syntax (return entire new context)
assign(({ context, event }) => ({
  ...context,
  count: context.count + 1,
}))
```

**Never mutate context directly.** `context.count++` causes bugs with shared references and persistence.

---

## Actions

### Built-in Action Creators

```ts
import {
  assign,         // Update context
  raise,          // Internal event (processed in same macrostep)
  sendTo,         // Send event to another actor
  sendParent,     // Send event to parent actor
  emit,           // Emit event to external listeners (actor.on)
  log,            // Console logging
  spawnChild,     // Spawn child actor (fire-and-forget)
  stopChild,      // Stop child actor
  cancel,         // Cancel delayed raise/sendTo
  enqueueActions, // Conditional/dynamic action composition
} from 'xstate';
```

### Usage Patterns

```ts
// assign
actions: assign({ count: ({ context }) => context.count + 1 })

// raise (sends event to self, processed immediately after current transition)
actions: raise({ type: 'check' })

// sendTo (send event to another actor by ref or ID)
actions: sendTo('childId', { type: 'start' })
actions: sendTo(({ context }) => context.workerRef, { type: 'work' })

// sendParent (send event to parent)
actions: sendParent({ type: 'done', result: 42 })

// emit (to external listeners via actor.on())
actions: emit({ type: 'analytics', payload: 'clicked' })

// log
actions: log(({ context }) => `Count is ${context.count}`)

// spawnChild (fire-and-forget — no ref stored in context)
actions: spawnChild('someLogic', { id: 'bg-worker' })

// stopChild
actions: stopChild('bg-worker')
actions: stopChild(({ context }) => context.actorRef)

// cancel (cancel a delayed raise/sendTo by its id)
actions: cancel('delayedCheck')
```

### Named Actions with Params

```ts
setup({
  actions: {
    greet: (_, params: { name: string }) => {
      console.log(`Hello ${params.name}`);
    },
  },
}).createMachine({
  entry: {
    type: 'greet',
    params: ({ context }) => ({ name: context.userName }),
  },
});
```

### enqueueActions()

Replaces v4's `choose()` and `pure()`. Allows imperative conditional logic:

```ts
import { enqueueActions } from 'xstate';

entry: enqueueActions(({ context, event, enqueue, check }) => {
  // Conditional
  if (check('isAdmin')) {
    enqueue('notifyAdmin');
  }

  // Built-in helpers
  enqueue.assign({ processed: true });
  enqueue.sendTo('logger', { type: 'log', msg: 'entry' });
  enqueue.raise({ type: 'continue' });
  enqueue.spawnChild('worker', { id: 'w1' });
  enqueue.stopChild('w1');
  enqueue.cancel('someDelayed');

  // Named action with params
  enqueue({ type: 'greet', params: { name: 'World' } });
}),
```

**Enqueued actions must be synchronous.** No `await` inside `enqueueActions`.

---

## Guards

### Basic Guards

```ts
setup({
  guards: {
    isValid: ({ context }) => context.value.length > 0,
    isBelow: ({ context }, params: { max: number }) => context.count < params.max,
  },
}).createMachine({
  on: {
    submit: { guard: 'isValid', target: 'done' },
    increment: {
      guard: { type: 'isBelow', params: { max: 100 } },
      actions: assign({ count: ({ context }) => context.count + 1 }),
    },
  },
});
```

### Inline Guards

```ts
on: {
  submit: {
    guard: ({ context }) => context.value.length > 0,
    target: 'done',
  },
}
```

### Higher-Order Guards

```ts
import { and, or, not, stateIn } from 'xstate';

on: {
  submit: {
    guard: and(['isValid', not('isSubmitting')]),
    target: 'submitting',
  },
  access: {
    guard: or(['isAdmin', and(['isUser', 'hasVerifiedEmail'])]),
    target: 'dashboard',
  },
  play: {
    guard: stateIn({ audio: 'ready' }), // Check parallel region
    target: 'playing',
  },
}
```

---

## Delayed Transitions

```ts
states: {
  waiting: {
    after: {
      // Inline delay (milliseconds)
      3000: { target: 'timedOut' },

      // Named delay (from setup)
      retryDelay: { target: 'retrying', actions: 'incrementAttempt' },

      // Multiple delayed transitions
      1000: [
        { guard: 'shouldRetry', target: 'retrying' },
        { target: 'failed' },
      ],
    },
  },
}
```

Dynamic delays in setup:

```ts
setup({
  delays: {
    retryDelay: ({ context }) => Math.min(1000 * 2 ** context.attempt, 30000),
  },
})
```

Timers are **automatically cancelled** when the state is exited.

---

## Invoked Actors

### Basic Invocation

```ts
states: {
  loading: {
    invoke: {
      id: 'fetchData',                  // Unique ID for this invocation
      src: 'fetchLogic',                // Actor logic (from setup or inline)
      input: ({ context }) => ({        // Input to the actor
        url: context.endpoint,
      }),
      onDone: {                          // When actor completes successfully
        target: 'success',
        actions: assign({ data: ({ event }) => event.output }),
      },
      onError: {                         // When actor throws/rejects
        target: 'error',
        actions: assign({ error: ({ event }) => event.error }),
      },
      onSnapshot: {                      // When actor emits a new snapshot
        actions: ({ event }) => console.log(event.snapshot),
      },
    },
  },
}
```

### Multiple Invocations

```ts
invoke: [
  { id: 'fetch1', src: 'fetchUser', input: ({ context }) => ({ id: context.userId }) },
  { id: 'fetch2', src: 'fetchPosts', input: ({ context }) => ({ userId: context.userId }) },
],
```

### Invoking Child Machines

```ts
const childMachine = setup({ /* ... */ }).createMachine({ /* ... */ });

const parentMachine = setup({
  actors: { child: childMachine },
}).createMachine({
  states: {
    active: {
      invoke: {
        id: 'childActor',
        src: 'child',
        input: ({ context }) => ({ data: context.data }),
        onDone: {
          target: 'complete',
          actions: assign({ result: ({ event }) => event.output }),
        },
      },
    },
  },
});
```

---

## Spawned Actors

### spawn inside assign

```ts
entry: assign({
  ref: ({ spawn }) => spawn('workerLogic', {
    id: 'worker-1',
    input: { task: 'process' },
  }),
}),
```

### spawnChild action (no ref stored)

```ts
import { spawnChild, stopChild, sendTo } from 'xstate';

entry: spawnChild('workerLogic', { id: 'worker-1' }),

on: {
  message: { actions: sendTo('worker-1', ({ event }) => ({ type: 'task', data: event.data })) },
  stop: { actions: stopChild('worker-1') },
}
```

---

## Actor Logic Creators

### fromPromise

```ts
import { fromPromise } from 'xstate';

const fetchUser = fromPromise(async ({ input, signal }: {
  input: { userId: string };
  signal: AbortSignal;
}) => {
  const res = await fetch(`/api/users/${input.userId}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
});
```

`signal` is an AbortSignal — cancelled when the invocation/actor is stopped.

### fromCallback

```ts
import { fromCallback } from 'xstate';

const socketLogic = fromCallback(({ sendBack, receive, input }) => {
  const ws = new WebSocket(input.url);

  ws.onmessage = (e) => sendBack({ type: 'message', data: JSON.parse(e.data) });
  ws.onerror = (e) => sendBack({ type: 'error', error: e });

  receive((event) => {
    if (event.type === 'send') ws.send(JSON.stringify(event.data));
  });

  return () => ws.close(); // Cleanup function
});
```

### fromObservable

```ts
import { fromObservable } from 'xstate';
import { interval } from 'rxjs';

const ticker = fromObservable(() => interval(1000));
// Snapshot context is the latest emitted value
```

### fromEventObservable

```ts
import { fromEventObservable } from 'xstate';
import { fromEvent } from 'rxjs';

const clicks = fromEventObservable(() =>
  fromEvent(document, 'click') as Subscribable<EventObject>
);
// Events from the observable are forwarded to the parent actor
```

### fromTransition

```ts
import { fromTransition } from 'xstate';

const counterLogic = fromTransition(
  (state, event) => {
    if (event.type === 'inc') return { ...state, count: state.count + 1 };
    if (event.type === 'dec') return { ...state, count: state.count - 1 };
    return state;
  },
  ({ input }) => ({ count: input.initial ?? 0 }), // Initial state (can use input)
);
```

---

## Events and Messaging

### raise() — Self-Event

```ts
actions: raise({ type: 'next' })

// Delayed raise
actions: raise({ type: 'timeout' }, { delay: 5000, id: 'timeoutId' })
```

### sendTo() — Send to Other Actor

```ts
actions: sendTo('childId', { type: 'start' })
actions: sendTo(({ context }) => context.someRef, { type: 'data', payload: 42 })

// Delayed
actions: sendTo('child', { type: 'ping' }, { delay: 1000, id: 'pingId' })
```

### sendParent() — Send to Parent

```ts
actions: sendParent({ type: 'childDone', result: 42 })
```

### cancel() — Cancel Delayed Events

```ts
actions: cancel('timeoutId')  // Cancels a delayed raise/sendTo by its id
```

---

## Input and Output

### Machine Input

```ts
const machine = setup({
  types: { input: {} as { userId: string } },
}).createMachine({
  context: ({ input }) => ({ userId: input.userId, data: null }),
});

const actor = createActor(machine, { input: { userId: 'abc' } });
```

### Invoke Input

```ts
invoke: {
  src: 'fetchData',
  input: ({ context, event }) => ({ url: context.apiUrl }),
}
```

### Machine Output

```ts
createMachine({
  states: {
    done: { type: 'final' },
  },
  output: ({ context }) => ({ result: context.processedData }),
});

// Read output
const snapshot = actor.getSnapshot();
if (snapshot.status === 'done') {
  console.log(snapshot.output);
}

// Or from invoke onDone
onDone: {
  actions: ({ event }) => console.log(event.output),
}
```

---

## Persistence

```ts
// Get serializable snapshot
const persisted = actor.getPersistedSnapshot();
const json = JSON.stringify(persisted);
localStorage.setItem('state', json);

// Restore
const restored = JSON.parse(localStorage.getItem('state')!);
const restoredActor = createActor(machine, { snapshot: restored }).start();
```

- Deep: child actors are recursively persisted/restored.
- Entry actions are NOT re-executed on restore.
- Invocations ARE restarted on restore.

---

## Pure Transition Functions

Compute state transitions without creating actors (useful for testing, SSR):

```ts
import { initialTransition, transition } from 'xstate';

const [initialState, initialActions] = initialTransition(machine);

const [nextState, actions] = transition(machine, initialState, { type: 'click' });
console.log(nextState.value);  // Next state
console.log(actions);          // Actions that would execute
```

**Prefer these over the deprecated `getInitialSnapshot()` / `getNextSnapshot()`.**

---

## Inspection

```ts
const actor = createActor(machine, {
  inspect: (event) => {
    switch (event.type) {
      case '@xstate.snapshot':
        console.log('State changed:', event.snapshot);
        break;
      case '@xstate.event':
        console.log('Event received:', event.event);
        break;
      case '@xstate.actor':
        console.log('Actor created:', event.actorRef.id);
        break;
    }
  },
});
```

For visual inspection, use `@statelyai/inspect` with Stately Studio.

---

## Event Emitter

Actors can emit events to external listeners (outside the actor system):

```ts
import { emit } from 'xstate';

// Declare in setup types
setup({
  types: { emitted: {} as { type: 'countChanged'; count: number } },
})

// Emit in actions
actions: emit({ type: 'countChanged', count: 42 })

// Listen externally
actor.on('countChanged', (event) => {
  analytics.track('count_changed', { count: event.count });
});
```

---

## Tags and Meta

### Tags

String labels for semantic grouping:

```ts
states: {
  loading: { tags: ['busy'] },
  saving: { tags: ['busy'] },
  idle: { tags: ['ready'] },
}

snapshot.hasTag('busy'); // true if any active state has 'busy' tag
```

Prefer `hasTag()` over `matches()` — tags survive state restructuring.

### Meta

Arbitrary metadata on states:

```ts
states: {
  form: {
    meta: { title: 'Fill out the form', progress: 0.5 },
  },
}

snapshot.getMeta(); // Returns meta from all active state nodes
```

---

## Top-Level Exports

| Export | Category |
|---|---|
| `createMachine`, `setup` | Machine creation |
| `createActor`, `createEmptyActor` | Actor creation |
| `assign` | Context updates |
| `raise`, `sendTo`, `sendParent`, `emit` | Event actions |
| `log`, `cancel` | Utility actions |
| `spawnChild`, `stopChild` | Child actor management |
| `enqueueActions` | Conditional action composition |
| `fromPromise`, `fromCallback`, `fromObservable`, `fromEventObservable`, `fromTransition` | Actor logic |
| `and`, `or`, `not`, `stateIn` | Guard combinators |
| `waitFor`, `toPromise` | Actor utilities |
| `transition`, `initialTransition` | Pure transition functions |
| `getNextSnapshot`, `getInitialSnapshot` | *(deprecated)* |
| `assertEvent`, `matchesState` | Utilities |
