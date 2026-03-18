# `durable-machines` — Complete Design & Implementation Plan

> Durable XState v5 state machines powered by DBOS Transact.
> Write standard XState machines. Mark your wait points. Get durability for free.

---

## Table of Contents

1. [Vision & Core Insight](#1-vision--core-insight)
2. [Design Principles](#2-design-principles)
3. [Key Decisions](#3-key-decisions)
4. [Architecture](#4-architecture)
5. [The `durableState()` Marker](#5-the-durablestate-marker)
6. [The Workflow Loop](#6-the-workflow-loop)
7. [XState `after` Transition Mapping](#7-xstate-after-transition-mapping)
8. [Public API](#8-public-api)
9. [Inspectability via `DBOS.listWorkflowSteps()`](#9-inspectability-via-dboslistworkflowsteps)
10. [Visualization](#10-visualization)
11. [Recovery Model](#11-recovery-model)
12. [Scale-to-Zero with KEDA](#12-scale-to-zero-with-keda)
13. [Multi-Replica Clustering](#13-multi-replica-clustering)
14. [Webhook Gateway](#14-webhook-gateway)
15. [Prompts & Channels](#15-prompts--channels)
16. [Testing Strategy](#16-testing-strategy)
17. [Validation](#17-validation)
18. [File Structure](#18-file-structure)
19. [Implementation Phases](#19-implementation-phases)
20. [Risks & Mitigations](#20-risks--mitigations)
21. [Appendix: Rejected Approaches](#21-appendix-rejected-approaches)

---

## 1. Vision & Core Insight

XState defines the *shape* of workflow logic — states, transitions, guards, actions. DBOS guarantees *it actually runs to completion* — durability, exactly-once steps, crash recovery.

The two are complementary at a deep level: XState's clean separation of pure logic from side effects is exactly the seam where DBOS can insert itself. The developer writes a normal XState machine. The library makes it durable.

```ts
import { setup, assign, fromPromise } from "xstate";
import { createDurableMachine, durableState } from "@durable-machines/machine";

const orderMachine = setup({ /* normal XState setup */ }).createMachine({
  id: "order",
  initial: "pending",
  states: {
    pending:    { ...durableState(), on: { PAY: "processing" } },
    processing: { invoke: { src: "processPayment", onDone: "paid" } },
    paid:       { ...durableState(), on: { SHIP: "shipping" }, after: { 86400000: "escalated" } },
    shipping:   { invoke: { src: "shipOrder", onDone: "delivered" } },
    delivered:  { type: "final" },
    escalated:  { type: "final" },
  },
});

const durable = createDurableMachine(orderMachine);
const handle = await durable.start("order-123", { orderId: "123", total: 99.99 });
await handle.send({ type: "PAY" });
```

The `paid` state has a 24-hour durable timeout. If the process crashes at hour 12 and restarts at hour 13, the machine resumes waiting for the remaining 11 hours. No timer table, no sweeper, no custom persistence. DBOS handles it.

---

## 2. Design Principles

1. **DBOS is the runtime.** The XState machine loop *is* a DBOS workflow function. Not a wrapper around DBOS. Not a consumer of DBOS primitives. The same thing.

2. **XState in pure functional mode.** We use `machine.getInitialSnapshot()` and `machine.transition(snapshot, event)`, never `createActor`. The machine definition is a pure data structure; DBOS provides the execution semantics.

3. **User-marked durable states.** The developer explicitly annotates which states are durable wait points. This is both a control mechanism ("here is where you may park") and documentation ("these are my system's durable boundaries").

4. **Zero custom persistence.** No custom snapshot table, no custom audit log. DBOS's native step replay handles recovery. `DBOS.listWorkflowSteps()` provides inspectability. `DBOS.setEvent()` publishes current state for external consumers.

5. **Scale to zero is free.** A workflow sitting in `DBOS.recv()` takes zero CPU. When the process dies and restarts, DBOS replays to the recv point and resumes.

6. **Prompts are data, channels are adapters.** The machine declares what it needs from humans (buttons, confirmations, forms) as metadata. Channel adapters (Slack, email, etc.) render the prompts. The machine never knows which channel delivered the response.

---

## 3. Key Decisions

These were established across multiple design sessions:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| XState version | v5 | Current, first-class pure functional API |
| DBOS target | Transact (TS, self-hosted) | No vendor lock-in |
| Recovery model | DBOS-native step replay | Eliminates custom snapshot persistence |
| XState execution mode | Pure functional (`machine.transition`) | Deterministic replay for DBOS recovery |
| State persistence | None — DBOS step replay reconstructs state | Simpler, less code, leverages DBOS |
| Audit log | `DBOS.listWorkflowSteps()` | No custom table needed |
| Durable state detection | User-marked via `durableState()` | Explicit, documentable, avoids fragile auto-detection |
| Composability (v0.1) | Flat only (single machine per workflow) | Nested durable actors deferred to v0.2 |
| Testing | Pure function tests + DBOS integration tests | No custom InMemoryBackend needed |
| Scaling | KEDA with Postgres triggers | Natural fit — scaling signal is pending work in Postgres |
| Multi-replica recovery | Heartbeat + reaper (pure Postgres) | No DBOS Conductor license required |
| Human interaction (outbound) | Prompts as metadata + channel adapters | Machine decoupled from Slack/email; channels are swappable |
| Human interaction (inbound) | Webhook gateway with source/router/transform | Stateless gateway, always-on, writes to Postgres via DBOSClient |
| Slash commands | Subcommand → event mapping | Natural fit for ops/internal tools; composes with interactive buttons |

### What Disappeared in the Architectural Pivot

The original design (session 1) used a snapshot-primary architecture with 7 modules and ~1200 lines. After discovering DBOS's native `recv` with durable timeout, the design collapsed to ~300 lines of core code:

| Removed Component | Replaced By |
|-------------------|-------------|
| `DurabilityBackend` interface | DBOS IS the backend |
| `DurableExecutionEngine` | The workflow while-loop |
| `DurableClock` / sleep sweeper | `DBOS.recv()` with timeout |
| Custom snapshot table | DBOS step replay reconstructs state |
| `InMemoryBackend` | Pure function tests (`machine.transition`) |
| Actor logic wrapper | Direct `DBOS.runStep()` in loop |
| Inspect handler / audit log bridge | `DBOS.listWorkflowSteps()` + `DBOS.setEvent()` |

---

## 4. Architecture

### Core: Machine Loop as DBOS Workflow

```
┌────────────────────────────────────────────────────────┐
│                     User Code                           │
│  const machine = setup({...}).createMachine({           │
│    states: {                                            │
│      pending:    { ...durableState(), ...prompt({...}) }   │
│      processing: { invoke: { src: "processPayment" } }  │
│      paid:       { ...durableState(), after: { ... } }     │
│    }                                                    │
│  })                                                     │
│  const durable = createDurableMachine(machine, {        │
│    channels: [slackChannel(client)]                     │
│  })                                                     │
└──────────────────────┬─────────────────────────────────┘
                       │
┌──────────────────────▼─────────────────────────────────┐
│            createDurableMachine()                        │
│  Validates machine def at registration time              │
│  Builds workflow function from machine + actor impls     │
│  Registers it with DBOS.registerWorkflow                 │
│  Returns: { start(), get(), list() }                    │
└──────────────────────┬─────────────────────────────────┘
                       │
┌──────────────────────▼─────────────────────────────────┐
│          DBOS Workflow: machineLoop()                    │
│                                                         │
│  while (status !== "done"):                             │
│    resolve transient transitions (always/eventless)     │
│    if invocation → DBOS.runStep(executor)               │
│    elif durableState:                                      │
│      if prompt → DBOS.runStep(channel.sendPrompt)       │
│      DBOS.recv(topic, timeout) ← waits for event       │
│      if prompt → DBOS.runStep(channel.resolvePrompt)    │
│    else → configuration error                           │
│                                                         │
│  Pure functions only: machine.transition(snapshot, ev)   │
│  All non-determinism wrapped in DBOS primitives          │
└──────────────────────┬─────────────────────────────────┘
                       │
┌──────────────────────▼─────────────────────────────────┐
│                   DBOS Runtime                           │
│  Recovery: replays workflow from beginning,              │
│            returns cached step/recv results               │
│  Persistence: workflow inputs, step outputs, recv msgs   │
│  Inspectability: listWorkflowSteps(), getEvent()         │
│  Communication: send() / recv() for durable events       │
│  Sleep: recv timeout = durable sleep                     │
└─────────────────────────────────────────────────────────┘
```

### Full System: Event Flow

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  Slack       │   │  Stripe     │   │  /slash cmd  │
│  Buttons     │   │  Webhooks   │   │              │
└──────┬───────┘   └──────┬──────┘   └──────┬───────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌──────────────────────────────────────────────────┐
│             Webhook Gateway (always on)            │
│  Sources: verify signatures, parse payloads        │
│  Routers: extract workflow ID from payload         │
│  Transforms: map payload → XState event            │
│                                                    │
│  DBOSClient.send(workflowId, event, "xstate.event")│
│  (Postgres write only — no DBOS runtime needed)    │
└──────────────────────┬───────────────────────────┘
                       │
              ┌────────▼─────────┐
              │    PostgreSQL    │
              │                  │◄──── KEDA queries every 15s
              │ dbos.workflow_   │      (pending messages?
              │   status         │       expired timeouts?)
              │ dbos.             │
              │   notifications  │      scales 0 ↔ N replicas
              │ dbos.             │
              │   workflow_events│
              └────────┬─────────┘
                       │
              ┌────────▼─────────┐
              │  DBOS Worker(s)  │
              │                  │───► Channel Adapters
              │  machineLoop:    │     (Slack, email, etc.)
              │   recv() returns │     send prompts to humans
              │   runStep()      │     resolve prompts after
              │   transition()   │     response
              └──────────────────┘
```

The key insight: the machine loop is deterministic because all non-determinism is wrapped in DBOS-managed operations. On recovery, DBOS replays from the beginning, each `runStep` returns its cached result, each `recv` returns its cached message/timeout, `machine.transition()` re-derives the same snapshots deterministically, and the loop fast-forwards to the exact interruption point.

---

## 5. The `durableState()` Marker

A durable state is one where the machine has no immediate work to do and is waiting for external input — an event, a signal, or a timeout.

### Implementation

```ts
// src/durable-state.ts

export function durableState() {
  return { meta: { "xstate-durable": { durable: true } } } as const;
}

export function isDurableState(machine: AnyStateMachine, snapshot: AnyMachineSnapshot): boolean {
  const stateNodes = machine.getStateNodeByPath(snapshot.value);
  return stateNodes.some(node => node.meta?.["xstate-durable"]?.durable === true);
}
```

Uses XState's `meta` field — the officially supported way to attach custom metadata to states. Preserved in the machine definition, serializable, and visible in tooling like Stately's editor.

### Classification of Non-Final States

Every non-final state must be exactly one of:

| Classification | How Detected | Loop Behavior |
|----------------|--------------|---------------|
| **Durable** | `durableState()` marker in meta | `DBOS.recv()` — wait for event or timeout |
| **Invoking** | Has `invoke` in state config | `DBOS.runStep()` — execute the service |
| **Transient** | Has `always` transition | `machine.transition()` — resolve immediately |

If a state is none of these, `createDurableMachine` throws a validation error at registration time. Fail fast, not at runtime.

Durable states can optionally carry a `prompt()` — metadata describing what to show the user while the machine waits (see [§15 Prompts & Channels](#15-prompts--channels)). The prompt is rendered by a channel adapter (Slack, email, etc.) when the loop enters the durable state, and resolved when the loop exits it.

### Usage Example

```ts
const orderMachine = setup({
  types: {} as {
    context: { orderId: string; total: number; chargeId?: string };
    events: { type: "PAY" } | { type: "SHIP" } | { type: "CANCEL" };
  },
  actors: {
    processPayment: fromPromise(async ({ input }) => {
      const charge = await stripe.charges.create({ amount: input.total });
      return { chargeId: charge.id };
    }),
    shipOrder: fromPromise(async ({ input }) => {
      const tracking = await shippingAPI.createShipment(input.orderId);
      return { trackingNumber: tracking.id };
    }),
  },
}).createMachine({
  id: "order",
  initial: "pending",
  context: ({ input }) => ({ orderId: input.orderId, total: input.total }),
  states: {
    pending: {
      ...durableState(),          // QUIESCENT: waits for PAY or CANCEL
      on: { PAY: "processing", CANCEL: "cancelled" },
    },
    processing: {               // INVOKING: runs processPayment
      invoke: {
        src: "processPayment",
        input: ({ context }) => ({ total: context.total }),
        onDone: {
          target: "paid",
          actions: assign({ chargeId: ({ event }) => event.output.chargeId }),
        },
        onError: "paymentFailed",
      },
    },
    paid: {
      ...durableState(),          // QUIESCENT: waits for SHIP, with 24h timeout
      on: { SHIP: "shipping" },
      after: { 86400000: "escalated" },
    },
    shipping: {                 // INVOKING: runs shipOrder
      invoke: {
        src: "shipOrder",
        input: ({ context }) => ({ orderId: context.orderId }),
        onDone: {
          target: "delivered",
          actions: assign({ trackingNumber: ({ event }) => event.output.trackingNumber }),
        },
        onError: "shipmentFailed",
      },
    },
    delivered:      { type: "final" },
    cancelled:      { type: "final" },
    escalated:      { type: "final" },
    paymentFailed:  { type: "final" },
    shipmentFailed: { type: "final" },
  },
});
```

---

## 6. The Workflow Loop

The entire execution engine. ~80 lines.

```ts
// src/machine-loop.ts

async function createMachineLoop(machine: AnyStateMachine, options: DurableMachineOptions) {
  validateMachineForDurability(machine);
  const actorImpls = extractActorImplementations(machine);

  return async function machineLoop(input: Record<string, unknown>) {
    let snapshot = machine.getInitialSnapshot({ input });
    await DBOS.setEvent("xstate.state", serializeSnapshot(snapshot));

    while (snapshot.status !== "done") {
      // 1. Resolve transient transitions (always/eventless)
      snapshot = resolveTransientTransitions(machine, snapshot);
      if (snapshot.status === "done") break;

      // 2. Determine what the current state needs
      const invocation = getActiveInvocation(machine, snapshot);

      if (invocation) {
        snapshot = await executeInvocation(machine, snapshot, invocation, actorImpls);
      } else if (isDurableState(machine, snapshot)) {
        snapshot = await waitForEventOrTimeout(machine, snapshot, options);
      } else {
        throw new DurableMachineError(
          `State "${JSON.stringify(snapshot.value)}" is not a durable state, ` +
          `has no invocation, and has no transient transition.`
        );
      }

      // 3. Publish updated state
      await DBOS.setEvent("xstate.state", serializeSnapshot(snapshot));
    }

    return snapshot.context;
  };
}
```

### `executeInvocation` — running a `fromPromise` service

```ts
async function executeInvocation(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  invocation: InvocationInfo,
  actorImpls: Map<string, Function>,
): Promise<AnyMachineSnapshot> {
  const executor = actorImpls.get(invocation.src);

  try {
    const output = await DBOS.runStep(
      () => executor({ input: invocation.input }),
      { name: `invoke:${invocation.src}` },
    );
    return machine.transition(snapshot, {
      type: `xstate.done.actor.${invocation.id}`,
      output,
    });
  } catch (error) {
    return machine.transition(snapshot, {
      type: `xstate.error.actor.${invocation.id}`,
      error,
    });
  }
}
```

### `waitForEventOrTimeout` — durable state handling

```ts
async function waitForEventOrTimeout(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  options: DurableMachineOptions,
): Promise<AnyMachineSnapshot> {
  const delays = getSortedAfterDelays(machine, snapshot);
  const hasAfter = delays.length > 0;

  const timeoutSec = hasAfter
    ? delays[0] / 1000
    : (options.maxWaitSeconds ?? 86400);

  // Write wake-up time for KEDA observability
  if (hasAfter) {
    const wakeAt = await DBOS.now() + (timeoutSec * 1000);
    await DBOS.setEvent("xstate.wakeAt", wakeAt);
  }

  const event = await DBOS.recv<AnyEventObject>("xstate.event", timeoutSec);

  await DBOS.setEvent("xstate.wakeAt", null);

  if (event !== null) {
    return machine.transition(snapshot, event);
  }

  if (hasAfter) {
    return machine.transition(snapshot, buildAfterEvent(machine, snapshot, delays[0]));
  }

  // No event, no timeout — loop re-enters and waits again
  return snapshot;
}
```

---

## 7. XState `after` Transition Mapping

XState's `after` transitions are race conditions: the delay competes with regular events. `DBOS.recv()` with a timeout models this perfectly.

### Simple case — one delay, no competing events

```ts
// states: { idle: { ...durableState(), after: { 5000: "timeout" } } }
const event = await DBOS.recv("xstate.event", 5);
// null → after fires, transition to "timeout"
```

### Common case — delay racing with external events

```ts
// states: {
//   paid: {
//     ...durableState(),
//     on: { SHIP: "shipping" },
//     after: { 86400000: "escalated" }
//   }
// }
const event = await DBOS.recv("xstate.event", 86400);
if (event) {
  // SHIP arrived before 24h → transition to "shipping"
} else {
  // 24h expired → transition to "escalated"
}
```

This is a 24-hour durable wait. Process crash at hour 12, restart at hour 13 → DBOS recovers workflow, fast-forwards to `recv`, resumes waiting for remaining 11 hours.

### Multiple delays on the same state

```ts
paid: {
  ...durableState(),
  after: {
    5000:  { actions: "sendReminder" },  // 5s: reminder, stay in "paid"
    30000: "timeout",                     // 30s: hard transition
  },
  on: { SHIP: "shipping" },
}
```

Handled by processing delays in ascending order:

1. Enter `paid`. `getSortedAfterDelays` returns `[5000, 30000]`.
2. `recv(timeout=5)`. If `SHIP` arrives within 5s, transition. Otherwise:
3. Fire the 5000ms `after` event. `sendReminder` runs. Machine stays in `paid`.
4. Loop re-enters. Track fired delays in a `Set<number>`. Next delay is 30000ms. Effective remaining wait: 25s.
5. `recv(timeout=25)`. If `SHIP` arrives, transition. Otherwise fire 30000ms `after` → `timeout`.

The `firedDelays` set is deterministic across replays because it's derived entirely from the sequence of `recv` timeouts, which DBOS replays deterministically.

---

## 8. Public API

```ts
// src/index.ts — public exports

interface DurableMachineOptions {
  maxWaitSeconds?: number;       // default: 86400 (24h) per recv cycle
  stepRetryPolicy?: StepConfig;  // DBOS retry config for invoke steps
}

interface DurableMachine<T extends AnyStateMachine> {
  start(workflowId: string, input: InputFrom<T>): Promise<DurableMachineHandle<T>>;
  get(workflowId: string): DurableMachineHandle<T>;
  list(filter?: { status?: string }): Promise<DurableMachineStatus[]>;
  readonly machine: T;
}

interface DurableMachineHandle<T extends AnyStateMachine> {
  readonly workflowId: string;
  send(event: EventFrom<T>): Promise<void>;
  getState(): Promise<DurableStateSnapshot | null>;
  getResult(): Promise<unknown>;
  getSteps(): Promise<StepInfo[]>;
  cancel(): Promise<void>;
}

interface DurableStateSnapshot {
  value: StateValue;
  context: Record<string, unknown>;
  status: "running" | "done" | "error";
}
```

### Implementation

```ts
export function createDurableMachine<T extends AnyStateMachine>(
  machine: T,
  options?: DurableMachineOptions,
): DurableMachine<T> {
  validateMachineForDurability(machine);

  const loop = createMachineLoop(machine, options ?? {});
  const workflow = DBOS.registerWorkflow(loop, { name: `xstate:${machine.id}` });

  return {
    machine,

    async start(workflowId, input) {
      const handle = await DBOS.startWorkflow(workflow, { workflowID: workflowId })(input);
      return createHandle(workflowId, handle);
    },

    get(workflowId) {
      const handle = DBOS.retrieveWorkflow(workflowId);
      return createHandle(workflowId, handle);
    },

    async list(filter) {
      const statuses = await DBOS.listWorkflows({
        workflowName: `xstate:${machine.id}`,
        status: filter?.status,
      });
      return statuses.map(s => ({
        workflowId: s.workflowID,
        status: s.status,
        workflowName: s.workflowName,
      }));
    },
  };
}
```

### External Event Delivery via `DBOSClient`

For sending events from processes that don't run DBOS (webhooks, API gateways, other services):

```ts
// src/client.ts

import { DBOSClient } from "@dbos-inc/dbos-sdk";

export async function sendMachineEvent(
  dbosClient: DBOSClient,
  workflowId: string,
  event: AnyEventObject,
): Promise<void> {
  await dbosClient.send(workflowId, event, "xstate.event");
}
```

Only needs a Postgres connection string. No DBOS runtime.

---

## 9. Inspectability via `DBOS.listWorkflowSteps()`

Instead of a custom audit log, we lean on DBOS's built-in step introspection. Each step is recorded with: `function_id`, `name` (our chosen name), `output`, `error`, `child_workflow_id`, `started_at_epoch_ms`, `completed_at_epoch_ms`.

Our workflow loop creates a readable execution trace:

```
Step 0: "setEvent:xstate.state"     → published initial state "pending"
Step 1: "recv:xstate.event"         → received { type: "PAY" }
Step 2: "setEvent:xstate.state"     → published state "processing"
Step 3: "invoke:processPayment"     → { chargeId: "ch_123" }
Step 4: "setEvent:xstate.state"     → published state "paid"
Step 5: "recv:xstate.event"         → timeout (null) after 86400s
Step 6: "setEvent:xstate.state"     → published state "escalated"
```

This is enough to reconstruct the full execution history: which states the machine visited, which services ran, what they returned, and how long each phase took.

---

## 10. Visualization

The `MachineVisualizationState` is computed from `listWorkflowSteps()` + `getEvent()`:

```ts
// src/visualization.ts

async function getVisualizationState(
  machine: AnyStateMachine,
  workflowId: string,
): Promise<MachineVisualizationState> {
  const steps = await DBOS.listWorkflowSteps(workflowId);
  const currentState = await DBOS.getEvent<DurableStateSnapshot>(
    workflowId, "xstate.state", 0.1,
  );

  const machineDef = serializeMachineDefinition(machine);

  // Walk steps to reconstruct transitions and timing
  const transitions: TransitionRecord[] = [];
  let prevStateValue: StateValue | null = null;

  for (const step of steps ?? []) {
    if (step.name.startsWith("setEvent:xstate.state") && step.output) {
      const published = step.output as DurableStateSnapshot;
      if (prevStateValue !== null) {
        transitions.push({
          from: prevStateValue,
          to: published.value,
          ts: step.completedAtEpochMs ?? 0,
        });
      }
      prevStateValue = published.value;
    }
  }

  const stateDurations = computeStateDurations(transitions);
  const activeStep = detectActiveStep(steps);
  const activeSleep = detectActiveSleep(steps);

  return { machineDefinition: machineDef, currentState, transitions, stateDurations, activeStep, activeSleep };
}
```

Works without a running actor — `DBOS.getEvent` reads from Postgres, and `listWorkflowSteps` queries the operation outputs table. You can visualize a completed workflow, a running workflow, or a crashed workflow identically.

---

## 11. Recovery Model

DBOS handles all of this natively:

1. DBOS detects the workflow has status `PENDING` (started but not completed).
2. DBOS calls the workflow function again with the original input.
3. The loop begins: `machine.getInitialSnapshot(input)`.
4. Each `DBOS.runStep()` → returns cached result without re-executing.
5. Each `DBOS.recv()` → returns cached message without waiting.
6. Each `DBOS.setEvent()` → replays the cached value.
7. `machine.transition()` is pure → same inputs, same outputs.
8. The loop fast-forwards to the exact interruption point.
9. The next `recv` or `runStep` with no cached result blocks/executes live.

### Long-running `recv` waits

If the machine was in `paid` with a 24h timeout and the process dies at hour 12:

1. DBOS restarts the workflow.
2. Replay fast-forwards through all completed steps.
3. The `recv("xstate.event", 86400)` call is reached.
4. DBOS knows this recv started at hour 0 with an 86400s timeout.
5. It resumes waiting for the remaining ~12 hours.
6. No timer table. No sweeper. DBOS tracks the wakeup time in its system database.

### Determinism requirement

The workflow function must be deterministic: same inputs + same step return values → same steps in the same order. This means:

- Guards must be pure functions of context and event.
- Actions (`assign`, etc.) must be deterministic.
- All non-deterministic operations must be inside `fromPromise` actors (which become `DBOS.runStep` calls).

This is an XState best practice regardless of DBOS.

---

## 12. Scale-to-Zero with KEDA

### Why KEDA, not Knative

Knative's scaling model is fundamentally wrong for this workload. Knative scales on HTTP request concurrency; our workload scales on "pending durable work in Postgres." Knative's cold-start model (activator buffers HTTP requests) fights with DBOS's recovery model (replay all pending workflows on startup). KEDA scales on arbitrary metrics, including Postgres queries — a natural fit.

### The Scaling Signals

Two things mean a pod needs to be running:

**Signal 1: Pending messages.** When `DBOS.send(workflowId, event, "xstate.event")` is called, a row lands in `dbos.notifications`. If no process is running, the row sits until recovery.

**Signal 2: Expired timeouts.** The library writes `xstate.wakeAt` (the next expected wake-up time) to `dbos.workflow_events` before entering `recv`. KEDA queries for workflows where this time has passed.

### KEDA Configuration

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: durable-machines-machines
spec:
  scaleTargetRef:
    name: durable-machines-worker
  minReplicaCount: 0
  maxReplicaCount: 10
  pollingInterval: 15
  cooldownPeriod: 120
  triggers:
    # Signal 1: events waiting for dormant machines
    - type: postgresql
      metadata:
        connectionFromEnv: DBOS_SYSTEM_DATABASE_URL
        query: >
          SELECT COUNT(*) FROM dbos.notifications n
          JOIN dbos.workflow_status ws
            ON n.destination_uuid = ws.workflow_uuid
          WHERE ws.status = 'PENDING'
            AND ws.name LIKE 'xstate:%'
            AND n.topic = 'xstate.event'
        targetQueryValue: "0"
        activationTargetQueryValue: "1"

    # Signal 2: expired recv timeouts
    - type: postgresql
      metadata:
        connectionFromEnv: DBOS_SYSTEM_DATABASE_URL
        query: >
          SELECT COUNT(*) FROM dbos.workflow_events we
          JOIN dbos.workflow_status ws
            ON we.workflow_uuid = ws.workflow_uuid
          WHERE ws.status = 'PENDING'
            AND ws.name LIKE 'xstate:%'
            AND we.key = '"xstate.wakeAt"'
            AND we.value IS NOT NULL
            AND we.value::text != 'null'
            AND we.value::bigint <= EXTRACT(EPOCH FROM NOW()) * 1000
        targetQueryValue: "0"
        activationTargetQueryValue: "1"
```

### Scale to N (proportional scaling)

For higher throughput, count distinct workflows with pending work and scale proportionally:

```yaml
triggers:
  - type: postgresql
    metadata:
      query: >
        SELECT COUNT(DISTINCT ws.workflow_uuid) FROM dbos.workflow_status ws
        LEFT JOIN dbos.notifications n
          ON n.destination_uuid = ws.workflow_uuid AND n.topic = 'xstate.event'
        LEFT JOIN dbos.workflow_events we
          ON we.workflow_uuid = ws.workflow_uuid
          AND we.key = '"xstate.wakeAt"'
          AND we.value IS NOT NULL AND we.value::text != 'null'
          AND we.value::bigint <= EXTRACT(EPOCH FROM NOW()) * 1000
        WHERE ws.status = 'PENDING' AND ws.name LIKE 'xstate:%'
          AND (n.destination_uuid IS NOT NULL OR we.workflow_uuid IS NOT NULL)
      targetQueryValue: "50"          # 1 replica per 50 active machines
      activationTargetQueryValue: "1"
```

### Worker Process Structure

```ts
// worker.ts

const executorId = process.env.HOSTNAME ?? `worker-${crypto.randomUUID()}`;

async function main() {
  DBOS.setConfig({ name: "my-app", systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL, executorId });
  const orderMachine = createDurableMachine(orderMachineDef);

  await DBOS.launch();  // recovers own PENDING workflows

  const cluster = await startCluster(executorId, db);
  app.listen(3000);

  process.on("SIGTERM", async () => {
    ready = false;
    server.close();
    await cluster.stop();
    await DBOS.shutdown();
    process.exit(0);
  });
}
```

---

## 13. Multi-Replica Clustering

### The Problem

DBOS tags each workflow with the `executor_id` of the process that started it. On restart, each executor only recovers *its own* workflows. In a KEDA scale-to-zero world with ephemeral pods, this creates orphans: pod-A starts a workflow, pod-A dies, pod-B starts but doesn't recover pod-A's workflows.

DBOS Conductor solves this in hosted deployments. For self-hosted, we build the same thing with pure Postgres in ~100 lines.

### Solution: Heartbeat + Reaper

One table:

```sql
CREATE TABLE IF NOT EXISTS durable_machines_executors (
  executor_id    TEXT PRIMARY KEY,
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Two background loops per executor:

**Heartbeat loop** (every 5s): `UPDATE ... SET last_heartbeat = NOW()`

**Reaper loop** (every 15s): Single atomic query that finds dead executors, deletes their heartbeat rows, and reassigns their PENDING workflows to the reaper's executor ID:

```sql
WITH reaper_lock AS (
  SELECT pg_try_advisory_xact_lock(hashtext('durable-machines-reaper')) AS acquired
),
dead AS (
  DELETE FROM durable_machines_executors
  WHERE last_heartbeat < NOW() - INTERVAL '30 seconds'
    AND (SELECT acquired FROM reaper_lock)
  RETURNING executor_id
),
orphaned_executors AS (
  SELECT DISTINCT ws.executor_id
  FROM dbos.workflow_status ws
  WHERE ws.status = 'PENDING' AND ws.name LIKE 'xstate:%'
    AND ws.executor_id != $MY_EXECUTOR_ID
    AND NOT EXISTS (
      SELECT 1 FROM durable_machines_executors xe WHERE xe.executor_id = ws.executor_id
    )
)
UPDATE dbos.workflow_status
SET executor_id = $MY_EXECUTOR_ID
WHERE status = 'PENDING' AND name LIKE 'xstate:%'
  AND (
    executor_id IN (SELECT executor_id FROM dead)
    OR executor_id IN (SELECT executor_id FROM orphaned_executors)
  )
RETURNING workflow_uuid
```

The advisory lock ensures only one reaper runs per cycle. After reassigning, `DBOS.resumeWorkflow()` triggers recovery for each claimed workflow.

### Race Safety

Multiple reapers racing is safe: `pg_try_advisory_xact_lock` is non-blocking — losers get zero rows and no-op. As a fallback, DBOS's step-level idempotency ensures that even if two replicas briefly execute the same workflow, only one checkpoints each step.

### Timing

| Scenario | Recovery Time |
|----------|---------------|
| Graceful shutdown (SIGTERM) | ≤15s (reaper detects missing heartbeat row) |
| Hard crash (OOM, node failure) | ≤45s (30s dead threshold + 15s reaper interval) |
| Scale-to-zero round trip | ~30-35s (KEDA poll + pod start + reaper cycle) |

All configurable. For tighter recovery: `heartbeatIntervalMs: 2000, reaperIntervalMs: 5000, deadThresholdMs: 10000` → hard crash recovery ≤15s.

### Postgres Load

Per pod: 1 UPDATE every 5s (heartbeat) + 1 SELECT/DELETE every 15s (reaper) = ~16 queries/minute. For 10 pods: ~160 queries/minute. Negligible.

### Deployment Tiers

| Tier | Config | Use Case |
|------|--------|----------|
| Scale 0↔1 | Fixed `executorId`, no cluster module | Simple deployments, most use cases |
| Scale 0↔N | Per-pod `executorId` + cluster module | High throughput, many concurrent machines |

The library code is identical. The difference is purely deployment configuration.

---

## 14. Webhook Gateway

### Architecture

The webhook receiver is separate from the DBOS worker. The worker might have zero replicas. The receiver is always-on (or serverless with near-zero cold start). Its only job: parse → route → write to Postgres via `DBOSClient`.

```
Slack/Stripe/GitHub
       │
       ▼
┌──────────────┐     DBOSClient.send()
│   Webhook    │     (Postgres write only)
│   Gateway    │──────────────────────────────┐
│  (always on) │                              │
└──────────────┘                              ▼
                                    ┌──────────────────┐
                                    │    PostgreSQL     │
                                    │ dbos.notifications│
                                    └────────┬─────────┘
                                             │
                                    KEDA scales up worker
                                             │
                                    ┌──────────────────┐
                                    │   DBOS Worker    │
                                    │  recv() returns   │
                                    └──────────────────┘
```

### Three Concepts

**Sources** — validate and parse incoming webhooks (signature verification, payload parsing):

```ts
interface WebhookSource<TPayload = unknown> {
  verify(req: IncomingRequest): Promise<boolean>;
  parse(req: IncomingRequest): Promise<TPayload>;
}
```

Built-in sources: `slackSource(signingSecret)`, `stripeSource(webhookSecret)`, `githubSource(webhookSecret)`, `genericSource()` (no verification, for development).

**Routers** — determine which workflow(s) receive the event:

```ts
interface WebhookRouter<TPayload = unknown> {
  route(payload: TPayload): string | string[] | null;
}
```

Built-in routers:
- `fieldRouter(extractFn)` — extract workflow ID from payload (most common)
- `lookupRouter(extractKey, db)` — query Postgres for target workflow (when webhook doesn't contain workflow ID directly)
- `broadcastRouter(filter, db)` — fan out to all matching workflows

**Transforms** — map webhook payload to XState event:

```ts
interface WebhookTransform<TPayload = unknown> {
  transform(payload: TPayload): AnyEventObject;
}
```

Built-in: `directTransform(extractFn)` — extract event type and data from payload.

### Binding

```ts
interface WebhookBinding<TPayload = unknown> {
  path: string;
  source: WebhookSource<TPayload>;
  router: WebhookRouter<TPayload>;
  transform: WebhookTransform<TPayload>;
}
```

### Dispatcher

```ts
function createWebhookDispatcher(
  client: DBOSClient,
  bindings: WebhookBinding[],
): express.Router {
  // For each binding: POST handler that verifies → parses → routes → transforms → sends
}
```

### Example: Slack Approval Workflow

Machine sends a Slack message with Approve/Reject buttons (using `block_id` = workflow ID). When the button is clicked, Slack posts to the webhook. The binding extracts the workflow ID from the action's value and the event type from the `action_id`:

```ts
const slackApprovalBinding: WebhookBinding<SlackPayload> = {
  path: "/webhooks/slack/interactive",
  source: slackSource(process.env.SLACK_SIGNING_SECRET!),
  router: fieldRouter(p => p.actions?.[0]?.value ?? null),
  transform: directTransform(p => ({
    type: p.actions![0].action_id,   // "APPROVE" or "REJECT"
    user: p.user!.id,
  })),
};
```

The gateway is stateless, has no DBOS dependency, and can run anywhere — Cloudflare Worker, tiny Express container, Lambda.

### Slash Commands

Slack slash commands map naturally to XState events — each subcommand becomes an event type. For internal tools and ops workflows this is a powerful interaction model: the team never leaves Slack.

```
/approval approve req-abc-123
/approval reject req-abc-123 --reason "budget exceeded"
/approval status req-abc-123
```

**Slash Command Source:**

Slash commands arrive as `application/x-www-form-urlencoded` with the entire subcommand + args in the `text` field. The source parses this into structured data:

```ts
interface SlackSlashPayload {
  command: string;            // "/approval"
  subcommand: string;         // "approve"
  workflowId: string | null;  // "req-abc-123"
  args: Record<string, string>;  // { reason: "budget exceeded" }
  rawText: string;
  userId: string;
  userName: string;
  channelId: string;
  responseUrl: string;        // for follow-up messages
}
```

The parser handles quoted strings and `--flag value` pairs. The source reuses the same Slack signature verification as interactive components.

**Subcommand → Event Mapping:**

```ts
const approvalSlash = slashCommandBinding(
  "/webhooks/slack/slash/approval",
  process.env.SLACK_SIGNING_SECRET!,
  {
    eventMap: {
      approve: "APPROVE",
      reject:  "REJECT",
      cancel:  "CANCEL",
    },
    usage: "Usage: /approval <approve|reject|cancel> <workflow-id> [--reason ...]",
  },
);
```

The `eventMap` is explicit — unknown subcommands get a helpful error response, not a silent failure.

**3-Second Acknowledgment:** Slack requires an HTTP response within 3 seconds. The gateway responds immediately ("Sent APPROVE to req-abc-123") then optionally follows up via the `response_url` once the machine processes the event. This works even when KEDA needs to cold-start the worker.

**The `status` Subcommand:** Handled entirely in the gateway via `DBOSClient.getEvent()` — reads the published state directly from Postgres without waking the worker. This is a read, not an event.

**Composability with Buttons:** Slash commands and interactive buttons aren't mutually exclusive. The same machine can accept events from both input methods. The machine definition is unchanged — it just sees `{ type: "APPROVE", user: "U1234" }` regardless of the source. Buttons suit non-technical users; slash commands suit power users and automation.

---

## 15. Prompts & Channels

The webhook gateway handles human → machine communication. Prompts handle the other direction: machine → human. When a machine enters a state that needs human input, it needs to notify the user and present options.

### The Problem

Without prompts, every human interaction point requires two states:

```ts
// Verbose and Slack-specific
sendingApprovalRequest: { invoke: { src: "sendSlackMessage", onDone: "waiting" } },
waitingForApproval: { ...durableState(), on: { APPROVE: "approved", REJECT: "rejected" } },
```

The Slack API calls are buried in `fromPromise` actors. The machine is coupled to a specific channel. Every interaction point doubles the state count.

### The Solution: Prompts as Data, Channels as Adapters

The machine declares *what* it needs from the human. A channel adapter decides *how* to render it.

**The `prompt()` helper** — sets XState metadata, just like `durableState()`:

```ts
import { prompt, durableState } from "@durable-machines/machine";

waitingForApproval: {
  ...durableState(),
  ...prompt({
    type: "choice",
    text: ({ context }) =>
      `Approval needed for ${context.requestTitle} ($${context.amount})`,
    options: [
      { label: "Approve", event: "APPROVE", style: "primary" },
      { label: "Reject",  event: "REJECT",  style: "danger" },
    ],
    recipient: ({ context }) => context.reviewerUserId,
  }),
  on: {
    APPROVE: "approved",
    REJECT: "rejected",
  },
  after: { 259200000: "expired" },  // 72h timeout
},
```

The prompt is pure data. The `event` fields create an explicit contract between the prompt and the state's `on` transitions — validated at registration time.

### Prompt Types

```ts
type PromptConfig =
  | ChoicePrompt      // buttons: "Approve" / "Reject"
  | ConfirmPrompt     // binary: "Confirm" / "Cancel"
  | TextInputPrompt   // free text: "Enter rejection reason"
  | FormPrompt;       // multi-field: name, date, dropdown
```

Each type specifies which XState event(s) it produces. The channel adapter renders the appropriate UI for each type.

### Channel Adapter Interface

```ts
interface ChannelAdapter {
  // Render a prompt — returns opaque handle for later updates
  sendPrompt(params: {
    workflowId: string;
    stateValue: StateValue;
    prompt: PromptConfig;
    context: Record<string, unknown>;
  }): Promise<{ handle: unknown }>;

  // Optional: update prompt after response (e.g., replace buttons with "Approved by @alice")
  resolvePrompt?(params: {
    handle: unknown;
    event: AnyEventObject;
    newStateValue: StateValue;
  }): Promise<void>;

  // Optional: update prompt when context changes within same state
  updatePrompt?(params: {
    handle: unknown;
    prompt: PromptConfig;
    context: Record<string, unknown>;
  }): Promise<void>;
}
```

### Built-in Adapters

**Slack** — choice → buttons in a message, confirm → two-button message, text_input → input block, form → modal (requires trigger_id). Uses `chat.postMessage` / `chat.update` for send/resolve/update. The `block_id` is set to the workflow ID for routing responses back.

**Email** — choice → email with action links (each link hits the webhook gateway), confirm → confirm/cancel links. The links encode the workflow ID and event type as query parameters.

**Console** — terminal prompts for development/testing. Uses `readline` to accept input.

### Integration with the Workflow Loop

The channel adapter runs inside the loop as a DBOS step. When the machine enters a durable state with a prompt, the loop sends the prompt before entering `recv`. When the machine leaves the state, the loop resolves the prompt:

```ts
// In the durable state branch of the loop:
const promptConfig = getPromptConfig(machine, snapshot);

if (promptConfig && channels.length > 0) {
  promptHandle = await DBOS.runStep(
    async () => {
      const handles = [];
      for (const channel of channels) {
        handles.push(await channel.sendPrompt({ workflowId, stateValue, prompt, context }));
      }
      return handles;
    },
    { name: `prompt:${JSON.stringify(snapshot.value)}` },
  );
}

// ... recv() ...

// After state transition, resolve the prompt:
if (promptHandle && stateChanged) {
  await DBOS.runStep(
    async () => { /* call resolvePrompt on each channel */ },
    { name: `resolve-prompt:${JSON.stringify(prevValue)}` },
  );
}
```

Both `sendPrompt` and `resolvePrompt` are wrapped in `DBOS.runStep` — on recovery, the Slack message is sent exactly once and updated exactly once.

### Multi-Channel

```ts
const durable = createDurableMachine(approvalMachine, {
  channels: [
    slackChannel(new WebClient(process.env.SLACK_BOT_TOKEN)),
    emailChannel(mailer, baseUrl),
  ],
});
```

The prompt is sent to all configured channels. First response from any channel wins — the `recv` returns, the machine transitions, and all prompts are resolved. This gives multi-channel notifications for free.

### Validation

`validateMachineForDurability` checks prompt/event consistency:

- Every event in the prompt's options must have a matching `on` handler
- States with prompts must be marked `durableState()`
- Mismatches fail at registration time, not when a user clicks a dead button

### Full Example

```ts
const orderMachine = setup({ /* actors */ }).createMachine({
  id: "order",
  initial: "pendingApproval",
  states: {
    pendingApproval: {
      ...durableState(),
      ...prompt({
        type: "choice",
        text: ({ context }) =>
          `Order #${context.orderId} for $${context.total} needs approval`,
        options: [
          { label: "Approve", event: "APPROVE", style: "primary" },
          { label: "Reject",  event: "REJECT",  style: "danger" },
        ],
        recipient: ({ context }) => context.reviewerSlackId,
      }),
      on: {
        APPROVE: { target: "processing", actions: assign({ approver: ({ event }) => event.user }) },
        REJECT: "rejected",
      },
      after: { 86400000: "expired" },
    },

    processing: { invoke: { src: "processPayment", onDone: "paid", onError: "paymentFailed" } },

    paid: {
      ...durableState(),
      ...prompt({
        type: "confirm",
        text: ({ context }) => `Order #${context.orderId} paid. Ready to ship?`,
        confirmEvent: "SHIP",
        cancelEvent: "CANCEL",
        recipient: ({ context }) => context.reviewerSlackId,
      }),
      on: { SHIP: "shipped", CANCEL: "refunding" },
      after: { 172800000: "autoShipped" },
    },

    // ... remaining states
  },
});
```

The machine reads as a business process. No Slack API calls in the definition. No channel-specific rendering. Just what needs to happen and who decides.

---

## 16. Testing Strategy

### Unit Tests: Pure Function Testing (No DBOS, No Postgres)

The machine definition is pure. Test it directly:

```ts
test("PAY transitions from pending to processing", () => {
  const snapshot = orderMachine.getInitialSnapshot({
    input: { orderId: "1", total: 50 },
  });
  const next = orderMachine.transition(snapshot, { type: "PAY" });
  expect(next.value).toBe("processing");
});

test("paid escalates after timeout event", () => {
  let snapshot = orderMachine.getInitialSnapshot({ input: { orderId: "1", total: 50 } });
  snapshot = orderMachine.transition(snapshot, { type: "PAY" });
  snapshot = orderMachine.transition(snapshot, {
    type: "xstate.done.actor.processPayment",
    output: { chargeId: "ch_1" },
  });
  expect(snapshot.value).toBe("paid");

  snapshot = orderMachine.transition(snapshot, { type: "xstate.after.86400000.paid" });
  expect(snapshot.value).toBe("escalated");
});
```

These tests run in milliseconds with zero infrastructure. They cover all state machine logic — guards, actions, transitions, context updates.

### Integration Tests: DBOS with Test Postgres

```ts
beforeAll(async () => { await DBOS.launch(); });
afterAll(async () => { await DBOS.shutdown(); });

test("full order lifecycle", async () => {
  const durable = createDurableMachine(orderMachine);
  const handle = await durable.start("test-order-1", { orderId: "123", total: 99.99 });

  await waitForState(handle, "pending");
  await handle.send({ type: "PAY" });
  await waitForState(handle, "paid");
  await handle.send({ type: "SHIP" });

  const result = await handle.getResult();
  expect(result.trackingNumber).toBeDefined();
});

test("inspect execution history", async () => {
  // ... start and advance machine ...
  const steps = await handle.getSteps();
  const invokeStep = steps.find(s => s.name === "invoke:processPayment");
  expect(invokeStep).toBeDefined();
  expect(invokeStep!.output).toEqual(expect.objectContaining({ chargeId: expect.any(String) }));
});
```

### Utility Function Tests

All XState utilities tested against real machine definitions in pure functional mode:

- `getActiveInvocation` returns the correct actor for an invoking state
- `getSortedAfterDelays` returns delays in ascending order
- `resolveTransientTransitions` follows `always` chains to durable/invoking states
- `buildAfterEvent` produces events that `machine.transition` accepts
- `isDurableState` correctly identifies marked states

### Validation Tests

- Machines with unmarked non-final states → validation error
- States with both invoke and `durableState()` → validation error
- Missing actor implementations → validation error
- Valid machines pass cleanly

---

## 17. Validation

`validateMachineForDurability` runs at registration time and fails fast:

```ts
function validateMachineForDurability(machine: AnyStateMachine): void {
  const errors: string[] = [];

  for (const [path, stateNode] of walkStateNodes(machine)) {
    if (stateNode.type === "final") continue;

    const hasInvoke = stateNode.invoke?.length > 0;
    const hasAlways = stateNode.always?.length > 0;
    const markedDurable = stateNode.meta?.["xstate-durable"]?.durable === true;
    const promptConfig = stateNode.meta?.["xstate-durable"]?.prompt;

    if (!hasInvoke && !hasAlways && !markedDurable) {
      errors.push(`State "${path}" has no invoke, no always, and is not durableState().`);
    }
    if (hasInvoke && markedDurable) {
      errors.push(`State "${path}" has both invoke and durableState(). Remove durableState().`);
    }
    if (hasInvoke) {
      for (const inv of stateNode.invoke) {
        if (!machine.implementations.actors[inv.src]) {
          errors.push(`State "${path}" invokes "${inv.src}" but no implementation found.`);
        }
      }
    }

    // Prompt validation
    if (promptConfig) {
      if (!markedDurable) {
        errors.push(`State "${path}" has a prompt but is not durableState(). Prompts only work on wait states.`);
      }
      const handledEvents = new Set(Object.keys(stateNode.on ?? {}));
      for (const eventType of getPromptEvents(promptConfig)) {
        if (!handledEvents.has(eventType)) {
          errors.push(
            `State "${path}" prompt references event "${eventType}" but has no matching "on" handler.`
          );
        }
      }
    }
  }

  if (errors.length > 0) throw new DurableMachineValidationError(errors);
}
```

---

## 18. File Structure

```
durable-machines/
├── src/
│   ├── index.ts                    # public exports
│   ├── create-durable-machine.ts   # createDurableMachine() entry point
│   ├── machine-loop.ts             # the DBOS workflow function + helpers
│   ├── durable-state.ts             # durableState() marker + isDurableState()
│   ├── prompt.ts                   # prompt() helper + PromptConfig types
│   ├── validate.ts                 # validateMachineForDurability()
│   ├── xstate-utils.ts             # getActiveInvocation, getSortedAfterDelays,
│   │                               # buildAfterEvent, resolveTransientTransitions,
│   │                               # extractActorImplementations, serializeSnapshot
│   ├── visualization.ts            # getVisualizationState, serializeMachineDefinition
│   ├── types.ts                    # shared types
│   ├── client.ts                   # sendMachineEvent via DBOSClient (~20 lines)
│   ├── cluster.ts                  # heartbeat + reaper (~100 lines)
│   ├── channels/
│   │   ├── types.ts                # ChannelAdapter interface
│   │   ├── slack.ts                # Slack buttons, modals, inputs
│   │   ├── email.ts                # Email with action links
│   │   └── console.ts              # Terminal prompts (dev/testing)
│   └── webhook/
│       ├── dispatcher.ts           # createWebhookDispatcher
│       ├── types.ts                # Source, Router, Transform interfaces
│       ├── sources/
│       │   ├── slack.ts            # interactive components
│       │   ├── slack-slash.ts      # slash command parser
│       │   ├── stripe.ts
│       │   ├── github.ts
│       │   └── generic.ts
│       ├── routers/
│       │   ├── field.ts            # extract from payload
│       │   ├── lookup.ts           # query Postgres
│       │   └── broadcast.ts        # fan-out
│       └── transforms/
│           └── direct.ts           # payload → event mapping
├── adapters/
│   └── keda.ts                     # KEDA manifest generator (~50 lines)
├── migrations/
│   └── 001_executors.sql           # CREATE TABLE durable_machines_executors
├── tests/
│   ├── unit/
│   │   ├── machine-logic.test.ts   # pure XState transition tests
│   │   ├── validate.test.ts        # validation error cases (incl. prompt/event mismatch)
│   │   ├── durable-state.test.ts    # marker detection
│   │   ├── prompt.test.ts          # prompt metadata extraction
│   │   └── xstate-utils.test.ts    # utility function tests
│   └── integration/
│       ├── lifecycle.test.ts       # start → send → getResult
│       ├── after-timeout.test.ts   # durable sleep via recv timeout
│       ├── crash-recovery.test.ts  # kill process, verify recovery
│       ├── prompt-channel.test.ts  # prompt send/resolve lifecycle
│       └── visualization.test.ts   # getVisualizationState from steps
└── package.json
```

### Size Estimates

| Component | Lines |
|-----------|-------|
| Core library (loop, durable-state, validate, utils) | ~300 |
| Public API (createDurableMachine, handle) | ~100 |
| Prompt helper + types | ~80 |
| Channel adapters (Slack, email, console) | ~250 |
| Visualization | ~100 |
| Client (sendMachineEvent) | ~20 |
| Cluster (heartbeat + reaper) | ~100 |
| Webhook dispatcher + sources (incl. slash commands) | ~350 |
| KEDA adapter | ~50 |
| **Total library** | **~1350** |
| Tests | ~600 |

---

## 19. Implementation Phases

### Phase 1: Core Types + Durable State Marker + Validation
*Estimated: 0.5 days*

- `durableState()` function and `isDurableState()` predicate
- `prompt()` function and `getPromptConfig()` predicate
- `validateMachineForDurability()` with all error cases (including prompt/event mismatch)
- All shared types (`DurableStateSnapshot`, `InvocationInfo`, `PromptConfig`, etc.)
- Unit tests for validation

**Testable outcome:** Can define a machine with durable state markers and prompts, validate it without any DBOS dependency.

### Phase 2: XState Utility Functions
*Estimated: 1 day*

- `getActiveInvocation(machine, snapshot)`
- `extractActorImplementations(machine)`
- `getSortedAfterDelays(machine, snapshot)`
- `buildAfterEvent(machine, snapshot, delay)`
- `resolveTransientTransitions(machine, snapshot)`
- `serializeSnapshot(snapshot)`

**Testable outcome:** All utilities tested against real XState machine definitions in pure functional mode.

### Phase 3: Workflow Loop + Public API
*Estimated: 2 days*

- `createMachineLoop()` — the DBOS workflow function
- `createDurableMachine()` — the public API
- `DurableMachineHandle` with `send()`, `getState()`, `getResult()`, `getSteps()`
- Integration with DBOS: `registerWorkflow`, `startWorkflow`, `runStep`, `recv`, `send`, `setEvent`, `getEvent`, `listWorkflowSteps`

**Testable outcome:** Full end-to-end lifecycle test. Requires running Postgres + DBOS.

### Phase 4: `after` Transition Edge Cases
*Estimated: 1 day*

- Multiple `after` delays on the same state
- `after` delay racing with external events
- `firedDelays` tracking for self-targeting after transitions
- `xstate.wakeAt` event for KEDA observability

**Testable outcome:** Complex delay scenarios tested end-to-end.

### Phase 5: Prompts & Channel Adapters
*Estimated: 1.5 days*

- Prompt metadata integration in the workflow loop (send before recv, resolve after transition, update on context change)
- `ChannelAdapter` interface
- Slack channel adapter (choice, confirm, text_input; sendPrompt, resolvePrompt, updatePrompt)
- Console channel adapter (for dev/testing)
- Prompt/event validation at registration time

**Testable outcome:** Machine with prompt enters durable state → Slack message sent → button click → machine transitions → Slack message updated. Console adapter tested without external dependencies.

### Phase 6: Visualization + Inspectability
*Estimated: 1 day*

- `getVisualizationState()` from `listWorkflowSteps()` + `getEvent()`
- `serializeMachineDefinition()` for the static graph
- `list()` for querying machine instances by status

**Testable outcome:** Visualization state correctly reflects traversal history, state durations, active step/sleep.

### Phase 7: Cluster + Client + Webhook
*Estimated: 2 days*

- `cluster.ts` — heartbeat + reaper
- `client.ts` — `sendMachineEvent` via `DBOSClient`
- Webhook dispatcher + Slack interactive source + Slack slash command source (others can follow)
- Slash command parser (subcommand extraction, `--flag value` parsing, `status` read path)
- KEDA manifest generator

**Testable outcome:** Multi-replica recovery test (start workflow on executor A, kill A, verify executor B claims and resumes). Webhook integration test. Slash command parsing tests.

### Total

| Phase | Days |
|-------|------|
| Phase 1: Types + durableState + prompt + validation | 0.5 |
| Phase 2: XState utilities | 1 |
| Phase 3: Workflow loop + public API | 2 |
| Phase 4: After transition edge cases | 1 |
| Phase 5: Prompts + channel adapters | 1.5 |
| Phase 6: Visualization + inspectability | 1 |
| Phase 7: Cluster + client + webhook + slash commands | 2 |
| **Total** | **9 days** |

---

## 20. Risks & Mitigations

### XState v5 pure functional API surface

**Risk:** `machine.transition(snapshot, event)` may not fully support all XState features in pure mode — specifically `assign` actions, parameterized actions, guard evaluation.

**Mitigation:** XState v5 explicitly supports this pattern. Verify in Phase 2 with concrete tests. Fallback: create a temporary actor, feed it the event, extract the snapshot.

### `DBOS.recv()` timeout granularity

**Risk:** `recv` timeout is in seconds. XState `after` delays are in milliseconds. Sub-second delays lose precision.

**Mitigation:** Round up to nearest second. Document that sub-second `after` delays are not supported. Sub-second timers are a UI concern, not a durable workflow concern.

### Events arriving during invoke execution

**Risk:** If `processPayment` takes 5 seconds and `CANCEL` arrives during that window, the cancel event sits in the DBOS recv queue. The machine sees it only on the next durable wait — *after* payment completes.

**Mitigation:** This is correct behavior for a durable workflow. Document explicitly. For cancellation-during-invoke semantics, split the state into a pre-invoke durable state.

### Context serialization

**Risk:** XState context must be JSON-serializable (DBOS stores as JSON).

**Mitigation:** Validation warns about this constraint. Add runtime check after each transition.

### Determinism of the loop

**Risk:** Non-deterministic guards cause replay divergence.

**Mitigation:** Document as a hard requirement. Guards must be pure functions of context and event.

### Machine versioning

**Risk:** New machine definition deployed while workflows are in-flight. DBOS replays with new code, which may diverge.

**Mitigation:** Out of scope for v0.1. DBOS has built-in application versioning. Document that definition changes require version management.

### DBOS system table schema stability

**Risk:** The KEDA queries and reaper depend on `dbos.workflow_status`, `dbos.notifications`, and `dbos.workflow_events` table schemas. These are DBOS internals.

**Mitigation:** The tables are officially documented in DBOS docs. Pin to a DBOS version range and test against it. The queries are simple (status checks, joins) and unlikely to break.

---

## 21. Appendix: Rejected Approaches

### Snapshot-Primary Recovery (Original Design, Session 1)

The first design used a custom snapshot table as the source of truth, with an event log for inspectability only. This required ~1200 lines across 7 modules: `DurabilityBackend` interface, `InMemoryBackend`, `DBOSBackend`, `DurableExecutionEngine`, `DurableClock` (with sleep sweeper), actor logic wrapper, and inspect handler.

**Rejected because:** Discovery of DBOS's native `recv` with durable timeout eliminated the need for all custom infrastructure. The workflow loop pattern is simpler (~300 lines), more correct (DBOS handles all persistence), and more maintainable.

### InMemoryBackend for Testing

The original design included an `InMemoryBackend` implementing the `DurabilityBackend` interface for fast unit tests without Postgres.

**Rejected because:** With the DBOS-native approach, XState's pure functional `machine.transition()` provides better unit testing than any mock backend could. Test the machine logic directly (millisecond tests, zero infrastructure). Test the integration with real DBOS + Postgres.

### Knative for Scale-to-Zero

Knative Serving's scaling model (based on HTTP request concurrency) is fundamentally wrong for durable workflow workloads. The recovery-on-cold-start problem, wrong scaling unit, and timeout sweep incompatibility create more problems than they solve.

**Rejected in favor of:** KEDA, which scales on arbitrary Postgres queries — the correct signal for "pending durable work."

### Auto-Detection of Durable States

Analyzing the machine definition to infer which states are wait points (no invoke, no always transition, has `on` handlers).

**Rejected because:** Fragile and opaque. The user marking `durableState()` is explicit documentation, prevents surprises, and gives the library a clear contract to validate against. It's also only a few characters per state.

### DBOS Conductor for Multi-Replica Recovery

Conductor provides executor health monitoring and workflow reassignment out of the box.

**Not rejected outright** — it's the recommended production solution for DBOS Cloud deployments. But for self-hosted deployments that want to avoid the licensing dependency, the heartbeat + reaper pattern provides the same functionality in ~100 lines of Postgres queries.
