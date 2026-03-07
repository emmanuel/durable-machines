# XState v5 Framework Integration

## Table of Contents

1. [React (@xstate/react)](#react-xstatereact)
2. [Vue (@xstate/vue)](#vue-xstatevue)
3. [Svelte (@xstate/svelte)](#svelte-xstatesvelte)
4. [Solid (@xstate/solid)](#solid-xstatesolid)
5. [Vanilla JavaScript](#vanilla-javascript)
6. [Best Practices](#best-practices)

---

## React (@xstate/react)

```bash
npm install xstate @xstate/react
```

### useMachine — Full Machine Lifecycle

Creates an actor and subscribes to it. The actor is started on mount and stopped on unmount.

```tsx
import { useMachine } from '@xstate/react';
import { counterMachine } from './counterMachine';

function Counter() {
  const [snapshot, send] = useMachine(counterMachine, {
    input: { initialCount: 0 },
    // snapshot: restoredState, // Restore from persisted state
  });

  return (
    <div>
      <p>State: {JSON.stringify(snapshot.value)}</p>
      <p>Count: {snapshot.context.count}</p>
      <p>Is loading: {snapshot.hasTag('loading') ? 'yes' : 'no'}</p>

      <button onClick={() => send({ type: 'increment' })}>
        Increment
      </button>
      <button
        onClick={() => send({ type: 'decrement' })}
        disabled={!snapshot.can({ type: 'decrement' })}
      >
        Decrement
      </button>

      {snapshot.matches('editing') && <EditForm />}
    </div>
  );
}
```

### useActorRef — Stable Ref Without Re-renders

Returns a stable actor ref. Does NOT subscribe to changes (no re-renders).

```tsx
import { useActorRef } from '@xstate/react';

function Parent() {
  const actorRef = useActorRef(counterMachine, {
    input: { initialCount: 0 },
  });

  return (
    <>
      <CountDisplay actorRef={actorRef} />
      <Controls actorRef={actorRef} />
    </>
  );
}
```

### useSelector — Optimized Subscriptions

Subscribes to a specific part of the actor's state. Only re-renders when the selected value changes.

```tsx
import { useSelector } from '@xstate/react';

function CountDisplay({ actorRef }: { actorRef: ActorRefFrom<typeof counterMachine> }) {
  const count = useSelector(actorRef, (snapshot) => snapshot.context.count);
  const isLoading = useSelector(actorRef, (snapshot) => snapshot.hasTag('loading'));

  return (
    <div>
      <span>{count}</span>
      {isLoading && <Spinner />}
    </div>
  );
}
```

**Custom equality function:**

```tsx
const items = useSelector(
  actorRef,
  (snapshot) => snapshot.context.items,
  (a, b) => a.length === b.length && a.every((item, i) => item.id === b[i].id),
);
```

### useActor — Subscribe to External Actor

For actors created outside React (e.g., globally, or passed via props/context):

```tsx
import { useActor } from '@xstate/react';

function ExternalActorComponent({ actorRef }) {
  const [snapshot, send] = useActor(actorRef);

  return <div>{snapshot.context.value}</div>;
}
```

### Providing Actor via React Context

```tsx
import { createContext, useContext } from 'react';
import { useActorRef, useSelector } from '@xstate/react';

const AppContext = createContext<ActorRefFrom<typeof appMachine>>(null!);

function AppProvider({ children }: { children: React.ReactNode }) {
  const actorRef = useActorRef(appMachine, { input: { /* ... */ } });
  return <AppContext.Provider value={actorRef}>{children}</AppContext.Provider>;
}

function useAppActor() {
  return useContext(AppContext);
}

function SomeComponent() {
  const actorRef = useAppActor();
  const user = useSelector(actorRef, (s) => s.context.user);
  return <div>{user?.name}</div>;
}
```

### React Pattern: Machine per Component Instance

Each component instance gets its own actor:

```tsx
function TodoItem({ todo }: { todo: Todo }) {
  const [snapshot, send] = useMachine(todoItemMachine, {
    input: { todo },
  });

  return (
    <li>
      <span>{snapshot.context.todo.title}</span>
      <button onClick={() => send({ type: 'toggle' })}>
        {snapshot.matches('completed') ? 'Undo' : 'Complete'}
      </button>
    </li>
  );
}
```

### React Pattern: Spawned Child Actors

```tsx
function TodoList() {
  const [snapshot, send] = useMachine(todoListMachine);

  return (
    <ul>
      {snapshot.context.todos.map((todo) => (
        <TodoItem key={todo.id} actorRef={todo.ref} />
      ))}
      <button onClick={() => send({ type: 'addTodo' })}>Add</button>
    </ul>
  );
}

function TodoItem({ actorRef }: { actorRef: ActorRefFrom<typeof todoItemMachine> }) {
  const [snapshot, send] = useActor(actorRef);
  return <li>{snapshot.context.title}</li>;
}
```

---

## Vue (@xstate/vue)

```bash
npm install xstate @xstate/vue
```

### useMachine

```vue
<script setup lang="ts">
import { useMachine } from '@xstate/vue';
import { counterMachine } from './counterMachine';

const { snapshot, send, actorRef } = useMachine(counterMachine, {
  input: { initialCount: 0 },
});
</script>

<template>
  <div>
    <p>State: {{ snapshot.value }}</p>
    <p>Count: {{ snapshot.context.count }}</p>
    <button @click="send({ type: 'increment' })">Increment</button>
    <button
      @click="send({ type: 'decrement' })"
      :disabled="!snapshot.can({ type: 'decrement' })"
    >
      Decrement
    </button>
  </div>
</template>
```

### useActor

For subscribing to an existing actor ref (e.g., from provide/inject):

```vue
<script setup lang="ts">
import { useActor } from '@xstate/vue';
import { inject } from 'vue';

const actorRef = inject('appActor')!;
const { snapshot, send } = useActor(actorRef);
</script>
```

### useSelector

```vue
<script setup lang="ts">
import { useSelector } from '@xstate/vue';

const props = defineProps<{ actorRef: ActorRefFrom<typeof counterMachine> }>();
const count = useSelector(props.actorRef, (s) => s.context.count);
</script>

<template>
  <span>{{ count }}</span>
</template>
```

---

## Svelte (@xstate/svelte)

```bash
npm install xstate @xstate/svelte
```

### useMachine

```svelte
<script>
  import { useMachine } from '@xstate/svelte';
  import { counterMachine } from './counterMachine';

  const { snapshot, send, actorRef } = useMachine(counterMachine, {
    input: { initialCount: 0 },
  });
</script>

<p>State: {$snapshot.value}</p>
<p>Count: {$snapshot.context.count}</p>
<button on:click={() => send({ type: 'increment' })}>Increment</button>
```

Note: `$snapshot` uses Svelte's auto-subscription syntax for stores.

### useSelector

```svelte
<script>
  import { useSelector } from '@xstate/svelte';

  export let actorRef;
  const count = useSelector(actorRef, (s) => s.context.count);
</script>

<span>{$count}</span>
```

---

## Solid (@xstate/solid)

```bash
npm install xstate @xstate/solid
```

### useMachine

```tsx
import { useMachine } from '@xstate/solid';
import { counterMachine } from './counterMachine';

function Counter() {
  const [snapshot, send] = useMachine(counterMachine, {
    input: { initialCount: 0 },
  });

  return (
    <div>
      <p>Count: {snapshot().context.count}</p>
      <button onClick={() => send({ type: 'increment' })}>+</button>
    </div>
  );
}
```

Note: In Solid, `snapshot` is an accessor (function), not a direct value.

### useSelector

```tsx
import { useSelector } from '@xstate/solid';

function Count(props: { actorRef: ActorRefFrom<typeof counterMachine> }) {
  const count = useSelector(props.actorRef, (s) => s.context.count);
  return <span>{count()}</span>;
}
```

---

## Vanilla JavaScript

No framework bindings needed — use `createActor` directly:

```ts
import { createActor } from 'xstate';
import { appMachine } from './appMachine';

const actor = createActor(appMachine, { input: { /* ... */ } });

// Subscribe to state changes
actor.subscribe((snapshot) => {
  // Update DOM manually
  document.getElementById('state')!.textContent = String(snapshot.value);
  document.getElementById('count')!.textContent = String(snapshot.context.count);
});

// Wire up event listeners
document.getElementById('btn')!.addEventListener('click', () => {
  actor.send({ type: 'increment' });
});

actor.start();

// Cleanup on page unload
window.addEventListener('beforeunload', () => actor.stop());
```

---

## Best Practices

### 1. Use useSelector for Performance

`useMachine` re-renders on EVERY state change. For large components, use `useActorRef` + `useSelector` to only re-render when specific values change:

```tsx
// ❌ Re-renders on every state change
const [snapshot, send] = useMachine(bigMachine);
return <span>{snapshot.context.count}</span>;

// ✅ Only re-renders when count changes
const actorRef = useActorRef(bigMachine);
const count = useSelector(actorRef, (s) => s.context.count);
return <span>{count}</span>;
```

### 2. Share Actors via Context, Not Prop Drilling

```tsx
// Create context for the actor
const GameContext = createContext<ActorRefFrom<typeof gameMachine>>(null!);

// Provide at the top
function App() {
  const actorRef = useActorRef(gameMachine);
  return (
    <GameContext.Provider value={actorRef}>
      <GameBoard />
    </GameContext.Provider>
  );
}

// Consume anywhere
function ScoreDisplay() {
  const actorRef = useContext(GameContext);
  const score = useSelector(actorRef, (s) => s.context.score);
  return <span>{score}</span>;
}
```

### 3. Use machine.provide() for Testing

```tsx
test('renders loading state', () => {
  const testMachine = myMachine.provide({
    actors: {
      fetchData: fromPromise(async () => new Promise(() => {})), // Never resolves
    },
  });

  render(<MyComponent machine={testMachine} />);
  expect(screen.getByText('Loading...')).toBeInTheDocument();
});
```

### 4. Prefer hasTag() Over matches()

Tags are resilient to state restructuring:

```tsx
// ❌ Brittle — breaks if state structure changes
{snapshot.matches('loading') && <Spinner />}
{snapshot.matches({ editing: 'saving' }) && <Spinner />}

// ✅ Resilient — add 'busy' tag to any loading/saving states
{snapshot.hasTag('busy') && <Spinner />}
```

### 5. Don't Create Machines Inside Components

Machine definitions should be created outside components (module scope). Creating them inside causes a new machine on every render:

```tsx
// ❌ New machine every render
function Counter() {
  const machine = createMachine({ /* ... */ }); // DON'T
  const [snapshot] = useMachine(machine);
}

// ✅ Machine created once at module level
const counterMachine = createMachine({ /* ... */ });

function Counter() {
  const [snapshot] = useMachine(counterMachine);
}
```
