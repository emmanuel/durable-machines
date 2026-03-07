# XState v5 TypeScript Guide

Requires **TypeScript 5.0+**. For best results, use the latest TypeScript version.

## Table of Contents

1. [Type Setup with setup()](#type-setup-with-setup)
2. [types Property (without setup)](#types-property-without-setup)
3. [Dynamic Parameters](#dynamic-parameters)
4. [assertEvent()](#assertevent)
5. [Typed Actors](#typed-actors)
6. [Typed Children](#typed-children)
7. [Type Helpers](#type-helpers)
8. [Common TypeScript Patterns](#common-typescript-patterns)

---

## Type Setup with setup()

The `setup()` function is the **primary and recommended** way to type XState machines. It provides automatic inference for context, events, actions, guards, actors, and delays throughout the machine.

```ts
import { setup, assign, fromPromise } from 'xstate';

interface User {
  id: string;
  name: string;
  email: string;
}

const userMachine = setup({
  types: {
    context: {} as {
      user: User | null;
      error: string | null;
      retries: number;
    },
    events: {} as
      | { type: 'fetch'; userId: string }
      | { type: 'retry' }
      | { type: 'reset' },
    input: {} as {
      maxRetries: number;
    },
    output: {} as {
      user: User | null;
    },
    emitted: {} as
      | { type: 'userLoaded'; user: User }
      | { type: 'error'; message: string },
  },
  actions: {
    logUser: ({ context }) => {
      // context is fully typed here
      console.log(context.user?.name);
    },
    notify: (_, params: { message: string }) => {
      // params are typed
      console.log(params.message);
    },
  },
  guards: {
    canRetry: ({ context }) => context.retries < 3,
    hasUser: ({ context }) => context.user !== null,
  },
  actors: {
    fetchUser: fromPromise(async ({ input }: { input: { userId: string } }) => {
      const res = await fetch(`/api/users/${input.userId}`);
      if (!res.ok) throw new Error('Not found');
      return res.json() as Promise<User>;
    }),
  },
}).createMachine({
  id: 'user',
  context: ({ input }) => ({
    // input is typed as { maxRetries: number }
    user: null,
    error: null,
    retries: 0,
  }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        fetch: 'loading',     // 'fetch' is autocompleted
        // typo: 'fech' → TypeScript error ✅
      },
    },
    loading: {
      invoke: {
        src: 'fetchUser',     // Autocompleted, typed
        input: ({ event }) => {
          // event is narrowed to { type: 'fetch'; userId: string }
          return { userId: event.userId };
        },
        onDone: {
          target: 'success',
          actions: [
            assign({
              user: ({ event }) => event.output, // output typed as User
            }),
            {
              type: 'notify',
              params: ({ event }) => ({ message: `Loaded ${event.output.name}` }),
            },
          ],
        },
        onError: {
          target: 'error',
          actions: assign({
            error: ({ event }) => String(event.error),
          }),
        },
      },
    },
    success: {
      entry: 'logUser',       // Autocompleted
      type: 'final',
    },
    error: {
      on: {
        retry: {
          guard: 'canRetry',  // Autocompleted
          target: 'loading',
          actions: assign({ retries: ({ context }) => context.retries + 1 }),
        },
      },
    },
  },
  output: ({ context }) => ({ user: context.user }),
});
```

**Everything is inferred:** event narrowing in transitions, output types on `onDone`, action/guard names in autocomplete, input types in context factory and invoke input.

---

## types Property (without setup)

If using `createMachine()` directly, provide types via the `types` property:

```ts
const machine = createMachine({
  types: {} as {
    context: { count: number };
    events: { type: 'inc' } | { type: 'dec' } | { type: 'set'; value: number };
    actions: { type: 'logTelemetry' };
  },
  context: { count: 0 },
  on: {
    inc: {
      actions: assign({ count: ({ context }) => context.count + 1 }),
    },
    set: {
      actions: assign({ count: ({ event }) => event.value }), // event.value is typed
    },
  },
});
```

`setup()` is preferred because it provides much better inference, especially for named implementations.

---

## Dynamic Parameters

The **recommended** way to pass data to actions and guards. Keeps implementations decoupled from events:

```ts
setup({
  types: {
    context: {} as { user: { name: string }; count: number },
  },
  actions: {
    greet: (_, params: { name: string }) => {
      console.log(`Hello, ${params.name}!`);
    },
    incrementBy: assign((_, params: { amount: number }) => ({
      count: (ctx: any) => ctx.count + params.amount,
    })),
  },
  guards: {
    isBelow: (_, params: { max: number }) => true, // simplified
  },
}).createMachine({
  entry: {
    type: 'greet',
    params: ({ context }) => ({ name: context.user.name }),
    // TypeScript validates: params must return { name: string }
  },
  on: {
    submit: {
      guard: { type: 'isBelow', params: { max: 100 } },
      // TypeScript validates: params must be { max: number }
    },
  },
});
```

**Prefer dynamic params over `assertEvent`** — params are more composable, testable, and don't couple actions to specific event shapes.

---

## assertEvent()

When you MUST access event-specific data in an action where the event type isn't narrowed (e.g., entry/exit actions that could be triggered by multiple events):

```ts
import { assertEvent, createMachine } from 'xstate';

const machine = createMachine({
  types: {
    events: {} as
      | { type: 'greet'; message: string }
      | { type: 'log'; level: string }
      | { type: 'other' },
  },
  states: {
    someState: {
      entry: ({ event }) => {
        // event is union of ALL events here — not narrowed
        assertEvent(event, 'greet');
        // Now TypeScript knows: event is { type: 'greet'; message: string }
        console.log(event.message);
      },
    },
  },
});
```

`assertEvent` throws at runtime if the event doesn't match. Use sparingly — dynamic params are usually better.

You can also assert multiple event types:

```ts
assertEvent(event, ['greet', 'log']);
// event is now { type: 'greet'; message: string } | { type: 'log'; level: string }
```

---

## Typed Actors

### Typed Invoke Actors

Actor types are automatically inferred when using `setup()`:

```ts
const fetchUser = fromPromise(
  async ({ input }: { input: { userId: string } }): Promise<User> => {
    // Return type is inferred as User
    return fetch(`/api/users/${input.userId}`).then(r => r.json());
  }
);

const machine = setup({
  actors: { fetchUser },
}).createMachine({
  invoke: {
    src: 'fetchUser',
    input: ({ context }) => ({ userId: context.id }), // Input typed
    onDone: {
      actions: ({ event }) => {
        event.output; // Typed as User
      },
    },
  },
});
```

### Typed Spawned Actor Refs

```ts
import { type ActorRefFrom } from 'xstate';

const childLogic = fromPromise(async () => 42);

type ChildRef = ActorRefFrom<typeof childLogic>;

const parentMachine = setup({
  types: {
    context: {} as { childRef: ChildRef | null },
  },
  actors: { childLogic },
}).createMachine({
  context: { childRef: null },
  entry: assign({
    childRef: ({ spawn }) => spawn('childLogic'),
    // spawn return type is automatically ActorRefFrom<typeof childLogic>
  }),
});
```

---

## Typed Children

You can strongly type the children (invoked/spawned actors) of a machine:

```ts
const fetcherLogic = fromPromise(async () => ({ name: 'World' }));

const machine = setup({
  types: {
    children: {} as {
      myFetcher: 'fetcherLogic';
      anotherChild: 'fetcherLogic';
    },
  },
  actors: { fetcherLogic },
}).createMachine({
  invoke: {
    src: 'fetcherLogic',
    id: 'myFetcher', // Autocompleted to valid child IDs
  },
});
```

---

## Type Helpers

XState exports several type utilities:

```ts
import type {
  SnapshotFrom,      // Type of a machine's snapshot
  EventFromLogic,    // Union of all event types
  ContextFrom,       // Type of context
  ActorRefFrom,      // Type of actor ref
  InputFrom,         // Type of input
  OutputFrom,        // Type of output
} from 'xstate';

// Usage
type MySnapshot = SnapshotFrom<typeof myMachine>;
type MyEvents = EventFromLogic<typeof myMachine>;
type MyContext = ContextFrom<typeof myMachine>;
type MyActorRef = ActorRefFrom<typeof myMachine>;
type MyInput = InputFrom<typeof myMachine>;
type MyOutput = OutputFrom<typeof myMachine>;

// Use in component props
function MyComponent({ actorRef }: { actorRef: ActorRefFrom<typeof myMachine> }) {
  // ...
}

// Use in callbacks
function handleSnapshot(snapshot: SnapshotFrom<typeof myMachine>) {
  snapshot.context; // Fully typed
  snapshot.value;   // Typed state value
}
```

### EventFrom with Specific Type

Narrow to a specific event:

```ts
import type { EventFrom } from 'xstate';

type SubmitEvent = EventFrom<typeof myMachine, 'submit'>;
// { type: 'submit'; data: FormData }
```

---

## Common TypeScript Patterns

### Pattern: Machine Factory

Create parameterized machines with type-safe input:

```ts
function createCounterMachine(config: { max: number; step: number }) {
  return setup({
    types: {
      context: {} as { count: number },
      events: {} as { type: 'inc' } | { type: 'dec' },
    },
    guards: {
      canIncrement: ({ context }) => context.count + config.step <= config.max,
    },
  }).createMachine({
    context: { count: 0 },
    on: {
      inc: {
        guard: 'canIncrement',
        actions: assign({ count: ({ context }) => context.count + config.step }),
      },
      dec: {
        actions: assign({ count: ({ context }) => Math.max(0, context.count - config.step) }),
      },
    },
  });
}

const fastCounter = createCounterMachine({ max: 1000, step: 10 });
```

### Pattern: Typed Event Handlers

```ts
function handleEvent(send: (event: EventFromLogic<typeof myMachine>) => void) {
  // Only valid events can be sent
  send({ type: 'submit', data: formData }); // ✅
  send({ type: 'invalid' });                // ❌ TypeScript error
}
```

### Pattern: Typed Selector

```ts
function useCount(actorRef: ActorRefFrom<typeof counterMachine>) {
  return useSelector(actorRef, (snapshot) => snapshot.context.count);
  // Return type is inferred as number
}
```

### Pattern: Type-Safe provide()

```ts
// machine.provide() preserves the machine's types
const testMachine = myMachine.provide({
  actions: {
    // Only declared action names are valid keys
    doSomething: () => { /* mock */ },
    // invalidAction: () => {} → TypeScript error ❌
  },
  guards: {
    // Only declared guard names are valid keys
    isValid: () => true,
  },
});
```

### Pattern: Extract State Value Type

```ts
type MachineSnapshot = SnapshotFrom<typeof myMachine>;
type StateValue = MachineSnapshot['value'];
// e.g., 'idle' | 'loading' | 'success' | 'error'
// or { region1: 'a' | 'b'; region2: 'x' | 'y' } for parallel
```

### Pattern: Conditional Types on State

```ts
function renderForState(snapshot: SnapshotFrom<typeof myMachine>) {
  if (snapshot.matches('loading')) {
    // TypeScript knows we're in 'loading' state
    return <Spinner />;
  }
  if (snapshot.matches('error')) {
    // Can safely access error context
    return <ErrorMessage error={snapshot.context.error!} />;
  }
  if (snapshot.matches('success')) {
    return <DataView data={snapshot.context.data!} />;
  }
  return <IdleView />;
}
```

---

## TypeScript Gotchas

1. **Use `{} as Type` syntax in types.** The `types` property uses TypeScript's type assertion to declare types without runtime values:
   ```ts
   types: {
     context: {} as { count: number },  // ✅
     context: { count: 0 },              // ❌ This is a value, not just a type
   }
   ```

2. **Always declare event types as unions with `type` property.**
   ```ts
   events: {} as
     | { type: 'inc' }
     | { type: 'set'; value: number },  // ✅
   ```

3. **setup() provides much better inference than createMachine() alone.** Always prefer setup() for TypeScript projects.

4. **Typegen is NOT supported in v5.** The `setup()` function and `types` property replace typegen for most use cases.

5. **Actor logic input types must match.** When invoking an actor, the `input` property's return type must match the actor's declared input type. TypeScript will catch mismatches.

6. **`assertEvent` is a runtime assertion.** It throws if the event doesn't match. Use dynamic params instead when possible.
