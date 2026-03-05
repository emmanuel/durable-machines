# xstate-dbos

Durable XState v5 state machines powered by [DBOS Transact](https://docs.dbos.dev/).

Write standard XState statecharts. `xstate-dbos` runs them as durable workflows backed by Postgres — surviving crashes, restarts, and long-term waits without custom persistence code.

## Why

XState defines the *shape* of workflow logic: states, transitions, guards, actions. DBOS guarantees it *actually runs to completion* with exactly-once step execution and automatic crash recovery. Together they give you:

- **Durable execution** — a process crash during a 24-hour wait resumes exactly where it left off
- **Exactly-once side effects** — invoked actors run as DBOS steps with deterministic replay
- **Scale to zero** — durable states use `DBOS.recv()`, consuming zero CPU while waiting
- **No custom persistence** — DBOS step replay handles all recovery; no event-store or snapshot table
- **Standard XState** — your machine definition is a plain XState v5 machine; nothing proprietary

## Install

```bash
npm install xstate-dbos xstate @dbos-inc/dbos-sdk
```

Requires Node >= 24, XState >= 5, and DBOS SDK >= 4.

## Quick start

```typescript
import { DBOS } from "@dbos-inc/dbos-sdk";
import { setup, fromPromise, assign } from "xstate";
import { createDurableMachine, durableState } from "xstate-dbos";

// 1. Define a standard XState machine
const orderMachine = setup({
  types: {
    context: {} as { orderId: string; total: number; chargeId?: string },
    events: {} as { type: "PAY" } | { type: "CANCEL" },
    input: {} as { orderId: string; total: number },
  },
  actors: {
    processPayment: fromPromise(
      async ({ input }: { input: { total: number } }) => {
        // This runs as a DBOS step — exactly once, even after crash recovery
        return { chargeId: `ch_${input.total}` };
      },
    ),
  },
}).createMachine({
  id: "order",
  initial: "pending",
  context: ({ input }) => ({ orderId: input.orderId, total: input.total }),
  states: {
    pending: {
      ...durableState(), // marks this state as a durable wait point
      on: { PAY: "processing", CANCEL: "cancelled" },
    },
    processing: {
      invoke: {
        src: "processPayment",
        input: ({ context }) => ({ total: context.total }),
        onDone: {
          target: "paid",
          actions: assign({
            chargeId: ({ event }) => event.output.chargeId,
          }),
        },
        onError: "failed",
      },
    },
    paid: { type: "final" },
    cancelled: { type: "final" },
    failed: { type: "final" },
  },
});

// 2. Register before DBOS.launch()
const durable = createDurableMachine(orderMachine);

// 3. Launch DBOS
DBOS.setConfig({ name: "my-app", systemDatabaseUrl: "postgresql://..." });
await DBOS.launch();

// 4. Start and interact with durable instances
const handle = await durable.start("order-123", { orderId: "o1", total: 99.99 });
await handle.send({ type: "PAY" });
const result = await handle.getResult(); // { orderId: "o1", total: 99.99, chargeId: "ch_99.99" }
```

## Concepts

### Three kinds of states

Every non-final atomic state in a durable machine must be exactly one of:

| Kind | Marker | DBOS primitive | Purpose |
|------|--------|----------------|---------|
| **Durable** | `durableState()` | `DBOS.recv()` | Wait for external events |
| **Invoking** | `invoke: { src }` | `DBOS.runStep()` | Run a side effect exactly once |
| **Transient** | `always: [...]` | `machine.transition()` | Route immediately via guards |

This is validated at registration time — if a state doesn't fit one of these categories, `createDurableMachine()` throws before your app starts.

### Durable states

Spread `durableState()` into any state that should durably wait for external input:

```typescript
pending: {
  ...durableState(),
  on: { PAY: "processing", CANCEL: "cancelled" },
},
```

The marker tells the workflow loop to call `DBOS.recv()` and wait. The process can shut down, restart, or scale to zero — DBOS will resume the wait on recovery.

### Prompts

Prompts are metadata on durable states describing what to present to a human. The machine doesn't know *how* the prompt is delivered (Slack, email, UI) — it only declares *what* to ask:

```typescript
awaitingApproval: {
  ...prompt({
    type: "choice",
    text: ({ context }) => `Approve order ${context.orderId} for $${context.total}?`,
    options: [
      { label: "Approve", event: "APPROVE" },
      { label: "Reject", event: "REJECT" },
    ],
  }),
  on: { APPROVE: "approved", REJECT: "rejected" },
},
```

Four prompt types are supported: `choice`, `confirm`, `text_input`, and `form`.

### `after` transitions

XState `after` delays work as durable timeouts. The shortest delay becomes the `DBOS.recv()` timeout, racing against external events:

```typescript
waitingForResponse: {
  ...durableState(),
  on: { RESPOND: "processing" },
  after: { 86400000: "escalated" }, // 24 hours
},
```

Multiple delays are supported — the workflow fires them in order. Self-targeting delays with `reenter: true` restart timers and re-fire entry actions, tracked via `firedDelays` to prevent duplicate execution during recovery. Named delays (defined in `setup({ delays })`) are resolved at runtime.

### Channel adapters

Channel adapters decouple prompt rendering from the state machine. The machine declares *what* to ask; the adapter decides *how* to deliver it (Slack, email, webhook, etc.).

```typescript
import { createDurableMachine, durableState, consoleChannel } from "xstate-dbos";

const channel = consoleChannel();
const durable = createDurableMachine(machine, { channels: [channel] });

// After the workflow reaches a prompt state:
console.log(channel.prompts); // [{ workflowId, prompt, context, resolvedWith? }]
```

The `ChannelAdapter` interface:

- **`sendPrompt(params)`** — render the prompt; returns an opaque handle
- **`resolvePrompt(params)`** — update the prompt after the user responds (optional)
- **`updatePrompt(params)`** — update the prompt when context changes within the same state (optional)

`consoleChannel()` is a built-in in-memory adapter for testing and development.

### External clients

Send events and read state from outside the DBOS runtime — only needs a Postgres connection:

```typescript
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { sendMachineEvent, getMachineState } from "xstate-dbos";

const client = new DBOSClient("postgresql://...");
await client.connect();

await sendMachineEvent(client, "order-123", { type: "PAY" });
const state = await getMachineState(client, "order-123");
```

## API

### `createDurableMachine(machine, options?)`

Registers an XState machine as a DBOS workflow. **Must be called before `DBOS.launch()`.**

Options:

- **`maxWaitSeconds`** — max seconds to wait for events in durable states (default: 86400)
- **`stepRetryPolicy`** — retry policy for invoke steps
- **`channels`** — channel adapters for prompt delivery
- **`enableTransitionStream`** — when `true`, records every state transition with timestamps for visualization (default: `false`)

Returns a `DurableMachine` with:

- **`start(workflowId, input)`** — start a new instance
- **`get(workflowId)`** — get a handle to an existing instance
- **`list(filter?)`** — list instances by status

### `DurableMachineHandle`

Returned by `start()` and `get()`:

- **`send(event)`** — deliver an event to the machine
- **`getState()`** — read current state snapshot
- **`getResult()`** — await final context (resolves when machine reaches a final state)
- **`getSteps()`** — list executed DBOS steps with names, outputs, and timing
- **`cancel()`** — cancel the workflow

### Markers

- **`durableState()`** — marks a state as a durable wait point
- **`prompt(config)`** — marks a state as a prompt (implies durable)

### Channel adapters

- **`consoleChannel()`** — in-memory channel adapter for testing/development

### Visualization

- **`serializeMachineDefinition(machine)`** — serialize the machine's static graph (states, transitions, metadata) into a flat, JSON-serializable `SerializedMachine` for UI rendering
- **`getVisualizationState(machine, workflowId)`** — combine the static graph with runtime data (current state, transition history, step info, active sleep) into a `MachineVisualizationState` snapshot
- **`computeStateDurations(transitions)`** — compute time spent in each state from transition records
- **`detectActiveStep(steps)`** — find the currently executing (incomplete) step

### Utilities

- **`validateMachineForDurability(machine)`** — validate without registering
- **`isDurableState(machine, snapshot)`** — check if current state is a durable state
- **`getPromptConfig(meta)`** — extract prompt config from state metadata
- **`getPromptEvents(config)`** — extract event types from a prompt config
- **`sendMachineEvent(client, workflowId, event)`** — send event via external client
- **`getMachineState(client, workflowId)`** — read state via external client

## How recovery works

1. DBOS detects a workflow is `PENDING` after restart
2. It calls the workflow function again with the original input
3. Each `DBOS.runStep()` returns its cached result (no re-execution)
4. Each `DBOS.recv()` returns its cached message (no re-wait)
5. `machine.transition()` is pure — same inputs produce same outputs
6. The loop fast-forwards to the interruption point
7. The next step or recv with no cache executes live

No snapshots to manage. No event store to compact. DBOS handles it all.

## Development

```bash
# Prerequisites: Node >= 24, pnpm, Docker

pnpm install
pnpm db:up                # Start test Postgres on port 5442
pnpm test                 # Run all tests (unit + integration)
pnpm test:unit            # Unit tests only
pnpm test:integration     # Integration tests only (requires Postgres)
pnpm db:down              # Stop Postgres
```

## Current status

This library is under active development. The core workflow engine is functional and tested end-to-end.

### Implemented

- Core type system and error hierarchy
- `durableState()` and `prompt()` state markers with four prompt types (`choice`, `confirm`, `text_input`, `form`)
- Machine validation at registration time
- XState utility functions (invocation extraction, delay handling, transient resolution, snapshot serialization)
- DBOS workflow loop with invoke execution, event reception, and `after` timeout handling
- `after` transitions with multiple delays, `firedDelays` tracking, `reenter: true` support, and named delays
- Channel adapter interface with `consoleChannel()` built-in adapter
- Prompt lifecycle: `sendPrompt` on entry, `resolvePrompt` on transition
- Public API: `createDurableMachine`, `DurableMachineHandle`
- External client helpers (`sendMachineEvent`, `getMachineState`)
- Visualization: `serializeMachineDefinition()`, `getVisualizationState()`, opt-in transition stream
- 86 tests (63 unit + 23 integration)

### Planned

- Channel adapters for external delivery (Slack, email, webhook)
- Webhook gateway for inbound event routing
- Multi-replica clustering (heartbeat + reaper)
- KEDA autoscaler manifest generation

## License

MIT
