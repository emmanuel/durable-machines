# XState v5 Common Patterns

## Table of Contents

1. [Fetch / Async Data](#fetch--async-data)
2. [Retry with Exponential Backoff](#retry-with-exponential-backoff)
3. [Multi-Step Form / Wizard](#multi-step-form--wizard)
4. [Authentication](#authentication)
5. [Polling](#polling)
6. [Debounce](#debounce)
7. [Undo/Redo](#undoredo)
8. [Dynamic Actor List](#dynamic-actor-list)
9. [Parallel Data Loading](#parallel-data-loading)
10. [Human-in-the-Loop (Approval)](#human-in-the-loop-approval)
11. [Pagination](#pagination)
12. [Optimistic Updates](#optimistic-updates)
13. [WebSocket Connection](#websocket-connection)
14. [Toggle / Boolean State](#toggle--boolean-state)

---

## Fetch / Async Data

The most common pattern. Invoke a promise in a loading state.

```ts
const fetchMachine = setup({
  types: {
    context: {} as { url: string; data: unknown; error: unknown },
    events: {} as { type: 'fetch' } | { type: 'retry' } | { type: 'refresh' },
    input: {} as { url: string },
  },
  actors: {
    fetchData: fromPromise(async ({ input }: { input: { url: string } }) => {
      const res = await fetch(input.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
  },
}).createMachine({
  id: 'fetch',
  context: ({ input }) => ({ url: input.url, data: null, error: null }),
  initial: 'idle',
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
          actions: assign({ data: ({ event }) => event.output, error: null }),
        },
        onError: {
          target: 'failure',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
    success: {
      on: { refresh: 'loading' },
    },
    failure: {
      on: { retry: 'loading' },
    },
  },
});
```

---

## Retry with Exponential Backoff

Use `after` transitions with dynamic delays.

```ts
const retryMachine = setup({
  types: {
    context: {} as { attempts: number; maxAttempts: number; data: unknown; error: unknown },
  },
  guards: {
    canRetry: ({ context }) => context.attempts < context.maxAttempts,
  },
  actors: {
    doWork: fromPromise(async ({ input }: { input: { attempt: number } }) => {
      // Your async operation
      const res = await fetch('/api/data');
      if (!res.ok) throw new Error('Failed');
      return res.json();
    }),
  },
  delays: {
    retryDelay: ({ context }) => Math.min(1000 * Math.pow(2, context.attempts), 30000),
  },
}).createMachine({
  id: 'retry',
  context: { attempts: 0, maxAttempts: 5, data: null, error: null },
  initial: 'attempting',
  states: {
    attempting: {
      invoke: {
        src: 'doWork',
        input: ({ context }) => ({ attempt: context.attempts }),
        onDone: {
          target: 'success',
          actions: assign({ data: ({ event }) => event.output }),
        },
        onError: [
          {
            guard: 'canRetry',
            target: 'waiting',
            actions: assign({ error: ({ event }) => event.error }),
          },
          {
            target: 'failed',
            actions: assign({ error: ({ event }) => event.error }),
          },
        ],
      },
    },
    waiting: {
      entry: assign({ attempts: ({ context }) => context.attempts + 1 }),
      after: {
        retryDelay: 'attempting',
      },
    },
    success: { type: 'final' },
    failed: { type: 'final' },
  },
  output: ({ context }) => ({ data: context.data, error: context.error }),
});
```

---

## Multi-Step Form / Wizard

Model each step as a state. Use context to accumulate form data.

```ts
const wizardMachine = setup({
  types: {
    context: {} as {
      step1: { name: string; email: string } | null;
      step2: { plan: string } | null;
      step3: { payment: string } | null;
    },
    events: {} as
      | { type: 'next'; data: Record<string, unknown> }
      | { type: 'back' }
      | { type: 'submit' },
  },
  actors: {
    submitForm: fromPromise(async ({ input }: { input: { formData: unknown } }) => {
      // submit logic
    }),
  },
}).createMachine({
  id: 'wizard',
  context: { step1: null, step2: null, step3: null },
  initial: 'step1',
  states: {
    step1: {
      on: {
        next: {
          target: 'step2',
          actions: assign({ step1: ({ event }) => event.data as any }),
        },
      },
    },
    step2: {
      on: {
        back: 'step1',
        next: {
          target: 'step3',
          actions: assign({ step2: ({ event }) => event.data as any }),
        },
      },
    },
    step3: {
      on: {
        back: 'step2',
        submit: {
          target: 'submitting',
          actions: assign({ step3: ({ event, context }) => event.data as any }),
        },
      },
    },
    submitting: {
      invoke: {
        src: 'submitForm',
        input: ({ context }) => ({ formData: context }),
        onDone: 'success',
        onError: 'step3', // Go back to last step on error
      },
    },
    success: { type: 'final' },
  },
});
```

---

## Authentication

```ts
const authMachine = setup({
  types: {
    context: {} as { user: User | null; error: string | null; token: string | null },
    events: {} as
      | { type: 'login'; credentials: { email: string; password: string } }
      | { type: 'logout' }
      | { type: 'tokenRefreshed'; token: string },
  },
  actors: {
    authenticate: fromPromise(async ({ input }: { input: { email: string; password: string } }) => {
      const res = await fetch('/api/login', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error('Invalid credentials');
      return res.json() as Promise<{ user: User; token: string }>;
    }),
  },
}).createMachine({
  id: 'auth',
  context: { user: null, error: null, token: null },
  initial: 'idle',
  states: {
    idle: {
      on: { login: 'authenticating' },
    },
    authenticating: {
      invoke: {
        src: 'authenticate',
        input: ({ event }) => {
          assertEvent(event, 'login');
          return event.credentials;
        },
        onDone: {
          target: 'authenticated',
          actions: assign({
            user: ({ event }) => event.output.user,
            token: ({ event }) => event.output.token,
            error: null,
          }),
        },
        onError: {
          target: 'idle',
          actions: assign({ error: ({ event }) => String(event.error) }),
        },
      },
    },
    authenticated: {
      on: {
        logout: {
          target: 'idle',
          actions: assign({ user: null, token: null, error: null }),
        },
      },
    },
  },
});
```

---

## Polling

Use a delayed self-transition to poll repeatedly while in a state.

```ts
const pollingMachine = setup({
  types: {
    context: {} as { data: unknown; interval: number },
    events: {} as { type: 'start' } | { type: 'stop' },
  },
  actors: {
    fetchData: fromPromise(async () => {
      const res = await fetch('/api/status');
      return res.json();
    }),
  },
  delays: {
    pollInterval: ({ context }) => context.interval,
  },
}).createMachine({
  id: 'poller',
  context: { data: null, interval: 5000 },
  initial: 'idle',
  states: {
    idle: {
      on: { start: 'polling' },
    },
    polling: {
      invoke: {
        src: 'fetchData',
        onDone: {
          actions: assign({ data: ({ event }) => event.output }),
        },
        onError: {
          // Optionally handle error
        },
      },
      after: {
        pollInterval: {
          target: 'polling',
          reenter: true, // Re-enter to re-invoke fetchData
        },
      },
      on: { stop: 'idle' },
    },
  },
});
```

---

## Debounce

Use a delayed transition that gets cancelled when a new event arrives.

```ts
const searchMachine = setup({
  types: {
    context: {} as { query: string; results: unknown[] },
    events: {} as { type: 'input'; value: string } | { type: 'clear' },
  },
  actors: {
    search: fromPromise(async ({ input }: { input: { query: string } }) => {
      const res = await fetch(`/api/search?q=${encodeURIComponent(input.query)}`);
      return res.json();
    }),
  },
}).createMachine({
  id: 'search',
  context: { query: '', results: [] },
  initial: 'idle',
  states: {
    idle: {
      on: {
        input: {
          target: 'debouncing',
          actions: assign({ query: ({ event }) => event.value }),
        },
      },
    },
    debouncing: {
      on: {
        input: {
          target: 'debouncing',
          reenter: true, // Restart the timer
          actions: assign({ query: ({ event }) => event.value }),
        },
        clear: { target: 'idle', actions: assign({ query: '', results: [] }) },
      },
      after: {
        300: 'searching', // Fires after 300ms of no new input
      },
    },
    searching: {
      invoke: {
        src: 'search',
        input: ({ context }) => ({ query: context.query }),
        onDone: {
          target: 'idle',
          actions: assign({ results: ({ event }) => event.output }),
        },
        onError: 'idle',
      },
      on: {
        input: {
          target: 'debouncing',
          actions: assign({ query: ({ event }) => event.value }),
        },
      },
    },
  },
});
```

---

## Undo/Redo

Track a history stack in context.

```ts
const undoRedoMachine = setup({
  types: {
    context: {} as {
      present: AppState;
      past: AppState[];
      future: AppState[];
    },
    events: {} as
      | { type: 'change'; state: AppState }
      | { type: 'undo' }
      | { type: 'redo' },
  },
  guards: {
    canUndo: ({ context }) => context.past.length > 0,
    canRedo: ({ context }) => context.future.length > 0,
  },
}).createMachine({
  context: { present: initialState, past: [], future: [] },
  on: {
    change: {
      actions: assign(({ context, event }) => ({
        past: [...context.past, context.present],
        present: event.state,
        future: [],
      })),
    },
    undo: {
      guard: 'canUndo',
      actions: assign(({ context }) => ({
        past: context.past.slice(0, -1),
        present: context.past[context.past.length - 1],
        future: [context.present, ...context.future],
      })),
    },
    redo: {
      guard: 'canRedo',
      actions: assign(({ context }) => ({
        past: [...context.past, context.present],
        present: context.future[0],
        future: context.future.slice(1),
      })),
    },
  },
});
```

---

## Dynamic Actor List

Spawn a dynamic number of child actors using context.

```ts
const parentMachine = setup({
  types: {
    context: {} as { items: Array<{ id: string; ref: ActorRefFrom<typeof itemLogic> }> },
    events: {} as
      | { type: 'addItem'; id: string }
      | { type: 'removeItem'; id: string }
      | { type: 'itemDone'; id: string },
  },
  actors: { itemLogic },
}).createMachine({
  context: { items: [] },
  on: {
    addItem: {
      actions: assign({
        items: ({ context, event, spawn }) => [
          ...context.items,
          { id: event.id, ref: spawn('itemLogic', { id: event.id }) },
        ],
      }),
    },
    removeItem: {
      actions: [
        stopChild(({ event }) => event.id),
        assign({
          items: ({ context, event }) =>
            context.items.filter((i) => i.id !== event.id),
        }),
      ],
    },
  },
});
```

---

## Parallel Data Loading

Load multiple resources simultaneously using a parallel state.

```ts
const loaderMachine = setup({
  actors: {
    fetchUser: fromPromise(async () => { /* ... */ }),
    fetchPosts: fromPromise(async () => { /* ... */ }),
    fetchSettings: fromPromise(async () => { /* ... */ }),
  },
}).createMachine({
  id: 'loader',
  type: 'parallel',
  context: { user: null, posts: null, settings: null },
  states: {
    user: {
      initial: 'loading',
      states: {
        loading: {
          invoke: {
            src: 'fetchUser',
            onDone: {
              target: 'done',
              actions: assign({ user: ({ event }) => event.output }),
            },
            onError: 'error',
          },
        },
        done: { type: 'final' },
        error: {},
      },
    },
    posts: {
      initial: 'loading',
      states: {
        loading: {
          invoke: {
            src: 'fetchPosts',
            onDone: {
              target: 'done',
              actions: assign({ posts: ({ event }) => event.output }),
            },
            onError: 'error',
          },
        },
        done: { type: 'final' },
        error: {},
      },
    },
    settings: {
      initial: 'loading',
      states: {
        loading: {
          invoke: {
            src: 'fetchSettings',
            onDone: {
              target: 'done',
              actions: assign({ settings: ({ event }) => event.output }),
            },
            onError: 'error',
          },
        },
        done: { type: 'final' },
        error: {},
      },
    },
  },
  // onDone fires when ALL regions reach final
  onDone: 'allLoaded',
});
```

---

## Human-in-the-Loop (Approval)

Wait for external input using a state that only transitions on a specific event.

```ts
const approvalMachine = setup({
  types: {
    context: {} as { requestId: string; decision: string | null },
    events: {} as
      | { type: 'submit' }
      | { type: 'approve' }
      | { type: 'reject' }
      | { type: 'timeout' },
  },
  actors: {
    sendNotification: fromPromise(async ({ input }: { input: { requestId: string } }) => {
      await fetch('/api/notify', { method: 'POST', body: JSON.stringify(input) });
    }),
  },
}).createMachine({
  id: 'approval',
  context: ({ input }) => ({ requestId: input.requestId, decision: null }),
  initial: 'draft',
  states: {
    draft: {
      on: { submit: 'pendingApproval' },
    },
    pendingApproval: {
      invoke: {
        src: 'sendNotification',
        input: ({ context }) => ({ requestId: context.requestId }),
      },
      after: {
        86400000: { target: 'timedOut' }, // 24 hours
      },
      on: {
        approve: {
          target: 'approved',
          actions: assign({ decision: 'approved' }),
        },
        reject: {
          target: 'rejected',
          actions: assign({ decision: 'rejected' }),
        },
      },
    },
    approved: { type: 'final' },
    rejected: { type: 'final' },
    timedOut: { type: 'final' },
  },
  output: ({ context }) => ({ decision: context.decision }),
});
```

---

## Pagination

```ts
const paginationMachine = setup({
  types: {
    context: {} as { page: number; pageSize: number; items: unknown[]; total: number },
    events: {} as { type: 'nextPage' } | { type: 'prevPage' } | { type: 'goToPage'; page: number },
  },
  guards: {
    hasNextPage: ({ context }) => context.page * context.pageSize < context.total,
    hasPrevPage: ({ context }) => context.page > 1,
  },
  actors: {
    fetchPage: fromPromise(async ({ input }: { input: { page: number; pageSize: number } }) => {
      const res = await fetch(`/api/items?page=${input.page}&size=${input.pageSize}`);
      return res.json() as Promise<{ items: unknown[]; total: number }>;
    }),
  },
}).createMachine({
  context: { page: 1, pageSize: 20, items: [], total: 0 },
  initial: 'loading',
  states: {
    loading: {
      invoke: {
        src: 'fetchPage',
        input: ({ context }) => ({ page: context.page, pageSize: context.pageSize }),
        onDone: {
          target: 'idle',
          actions: assign({
            items: ({ event }) => event.output.items,
            total: ({ event }) => event.output.total,
          }),
        },
        onError: 'error',
      },
    },
    idle: {
      on: {
        nextPage: {
          guard: 'hasNextPage',
          target: 'loading',
          actions: assign({ page: ({ context }) => context.page + 1 }),
        },
        prevPage: {
          guard: 'hasPrevPage',
          target: 'loading',
          actions: assign({ page: ({ context }) => context.page - 1 }),
        },
        goToPage: {
          target: 'loading',
          actions: assign({ page: ({ event }) => event.page }),
        },
      },
    },
    error: {
      on: { goToPage: { target: 'loading', actions: assign({ page: ({ event }) => event.page }) } },
    },
  },
});
```

---

## Optimistic Updates

Apply changes immediately, roll back on failure.

```ts
const optimisticMachine = setup({
  types: {
    context: {} as { items: Item[]; previousItems: Item[] | null },
    events: {} as { type: 'deleteItem'; id: string },
  },
  actors: {
    deleteItem: fromPromise(async ({ input }: { input: { id: string } }) => {
      const res = await fetch(`/api/items/${input.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
    }),
  },
}).createMachine({
  context: ({ input }) => ({ items: input.items, previousItems: null }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        deleteItem: {
          target: 'deleting',
          actions: assign(({ context, event }) => ({
            previousItems: context.items, // Save for rollback
            items: context.items.filter((i) => i.id !== event.id),
          })),
        },
      },
    },
    deleting: {
      invoke: {
        src: 'deleteItem',
        input: ({ event }) => ({ id: (event as any).id }),
        onDone: {
          target: 'idle',
          actions: assign({ previousItems: null }),
        },
        onError: {
          target: 'idle',
          actions: assign(({ context }) => ({
            items: context.previousItems ?? context.items, // Rollback
            previousItems: null,
          })),
        },
      },
    },
  },
});
```

---

## WebSocket Connection

Use `fromCallback` for bidirectional event-driven connections.

```ts
const wsMachine = setup({
  types: {
    context: {} as { url: string; messages: string[] },
    events: {} as
      | { type: 'connect' }
      | { type: 'disconnect' }
      | { type: 'send'; data: string }
      | { type: 'message'; data: string }
      | { type: 'error'; error: unknown },
  },
  actors: {
    wsConnection: fromCallback(({ sendBack, receive, input }) => {
      const ws = new WebSocket(input.url);
      ws.onopen = () => sendBack({ type: 'connected' });
      ws.onmessage = (e) => sendBack({ type: 'message', data: e.data });
      ws.onerror = (e) => sendBack({ type: 'error', error: e });
      ws.onclose = () => sendBack({ type: 'disconnected' });

      receive((event) => {
        if (event.type === 'send' && ws.readyState === WebSocket.OPEN) {
          ws.send(event.data);
        }
      });

      return () => ws.close();
    }),
  },
}).createMachine({
  context: ({ input }) => ({ url: input.url, messages: [] }),
  initial: 'disconnected',
  states: {
    disconnected: {
      on: { connect: 'connecting' },
    },
    connecting: {
      invoke: {
        id: 'ws',
        src: 'wsConnection',
        input: ({ context }) => ({ url: context.url }),
      },
      on: {
        connected: 'connected',
        error: 'disconnected',
      },
    },
    connected: {
      on: {
        send: {
          actions: sendTo('ws', ({ event }) => ({ type: 'send', data: event.data })),
        },
        message: {
          actions: assign({
            messages: ({ context, event }) => [...context.messages, event.data],
          }),
        },
        disconnect: 'disconnected',
        disconnected: 'disconnected',
        error: 'disconnected',
      },
    },
  },
});
```

---

## Toggle / Boolean State

The simplest pattern — two states with a single event.

```ts
const toggleMachine = createMachine({
  id: 'toggle',
  initial: 'inactive',
  states: {
    inactive: { on: { toggle: 'active' } },
    active: { on: { toggle: 'inactive' } },
  },
});
```

With context (e.g., tracking toggle count):

```ts
const toggleMachine = createMachine({
  id: 'toggle',
  initial: 'inactive',
  context: { count: 0 },
  states: {
    inactive: {
      on: {
        toggle: {
          target: 'active',
          actions: assign({ count: ({ context }) => context.count + 1 }),
        },
      },
    },
    active: {
      on: { toggle: 'inactive' },
      after: { 5000: 'inactive' }, // Auto-off after 5 seconds
    },
  },
});
```
