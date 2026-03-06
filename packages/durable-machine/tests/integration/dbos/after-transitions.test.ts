import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { setup, assign } from "xstate";
import { durableState } from "../../../src/index.js";
import { createDurableMachine } from "../../../src/dbos/index.js";

const SYSTEM_DB_URL =
  process.env.DBOS_SYSTEM_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

// ─── Test Machines ─────────────────────────────────────────────────────────

// Single after delay — times out to a final state
const singleDelayMachine = setup({
  types: {
    context: {} as { timedOut: boolean },
    events: {} as { type: "RESPOND" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "singleDelay",
  initial: "waiting",
  context: { timedOut: false },
  states: {
    waiting: {
      ...durableState(),
      on: { RESPOND: "responded" },
      after: {
        1000: {
          target: "timedOut",
          actions: assign({ timedOut: true }),
        },
      },
    },
    responded: { type: "final" },
    timedOut: { type: "final" },
  },
});

// Single after delay — event arrives before timeout
const raceEventMachine = setup({
  types: {
    context: {} as { winner: string },
    events: {} as { type: "RESPOND" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "raceEvent",
  initial: "waiting",
  context: { winner: "none" },
  states: {
    waiting: {
      ...durableState(),
      on: {
        RESPOND: {
          target: "responded",
          actions: assign({ winner: "event" }),
        },
      },
      after: {
        5000: {
          target: "timedOut",
          actions: assign({ winner: "timeout" }),
        },
      },
    },
    responded: { type: "final" },
    timedOut: { type: "final" },
  },
});

// Multiple after delays on the same state:
// 1s fires a reminder (no target, stays), 3s transitions out
const multiDelayMachine = setup({
  types: {
    context: {} as { reminders: number },
    events: {} as { type: "RESPOND" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "multiDelay",
  initial: "waiting",
  context: { reminders: 0 },
  states: {
    waiting: {
      ...durableState(),
      on: { RESPOND: "responded" },
      after: {
        1000: {
          actions: assign({ reminders: ({ context }) => context.reminders + 1 }),
        },
        3000: "escalated",
      },
    },
    responded: { type: "final" },
    escalated: { type: "final" },
  },
});

// Self-targeting after with reenter: true — ticks repeatedly
const selfTargetMachine = setup({
  types: {
    context: {} as { ticks: number },
    events: {} as { type: "STOP" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "selfTarget",
  initial: "ticking",
  context: { ticks: 0 },
  states: {
    ticking: {
      ...durableState(),
      on: { STOP: "stopped" },
      after: {
        1000: {
          target: "ticking",
          actions: assign({ ticks: ({ context }) => context.ticks + 1 }),
          reenter: true,
        },
      },
    },
    stopped: { type: "final" },
  },
});

// Named delay resolved from implementations
const namedDelayMachine = setup({
  types: {
    context: {} as { expired: boolean },
    events: {} as { type: "RESPOND" },
    input: {} as Record<string, never>,
  },
  delays: {
    shortTimeout: 1000,
  },
}).createMachine({
  id: "namedDelay",
  initial: "waiting",
  context: { expired: false },
  states: {
    waiting: {
      ...durableState(),
      on: { RESPOND: "responded" },
      after: {
        shortTimeout: {
          target: "timedOut",
          actions: assign({ expired: true }),
        },
      },
    },
    responded: { type: "final" },
    timedOut: { type: "final" },
  },
});

// ─── Register BEFORE launch ────────────────────────────────────────────────

DBOS.setConfig({
  name: "after-test",
  systemDatabaseUrl: SYSTEM_DB_URL,
});

const durableSingle = createDurableMachine(singleDelayMachine);
const durableRace = createDurableMachine(raceEventMachine);
const durableMulti = createDurableMachine(multiDelayMachine);
const durableSelfTarget = createDurableMachine(selfTargetMachine);
const durableNamed = createDurableMachine(namedDelayMachine);

// ─── Setup / Teardown ──────────────────────────────────────────────────────

beforeAll(async () => {
  await DBOS.launch();
});

afterAll(async () => {
  const pending = await DBOS.listWorkflows({ status: "PENDING" as any });
  await Promise.all(pending.map((w) => DBOS.cancelWorkflow(w.workflowID)));
  await DBOS.shutdown({ deregister: true });
});

// ─── Helper ────────────────────────────────────────────────────────────────

async function waitForState(
  handle: { getState(): Promise<{ value: unknown; context?: unknown } | null> },
  expected: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await handle.getState();
    if (state && JSON.stringify(state.value) === JSON.stringify(expected)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for state "${expected}"`);
}

async function waitForContext(
  handle: { getState(): Promise<{ value: unknown; context?: any } | null> },
  predicate: (ctx: any) => boolean,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await handle.getState();
    if (state?.context && predicate(state.context)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for context predicate");
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("after transitions", () => {
  it("fires a single after delay and transitions to final state", async () => {
    const id = `after-single-${Date.now()}`;
    const handle = await durableSingle.start(id, {});

    // Don't send any event — let the 1s timeout fire
    const result = await handle.getResult();
    expect(result).toMatchObject({ timedOut: true });
  });

  it("event wins the race against a longer after delay", async () => {
    const id = `after-race-${Date.now()}`;
    const handle = await durableRace.start(id, {});

    await waitForState(handle, "waiting");
    await handle.send({ type: "RESPOND" });

    const result = await handle.getResult();
    expect(result).toMatchObject({ winner: "event" });
  });

  it("fires multiple after delays in sequence on the same state", async () => {
    const id = `after-multi-${Date.now()}`;
    const handle = await durableMulti.start(id, {});

    // Let both delays fire: 1s reminder (stay), 3s escalate (final)
    const result = await handle.getResult();
    expect(result).toMatchObject({ reminders: 1 });
  });

  it("first after fires then event arrives before second after", async () => {
    const id = `after-multi-event-${Date.now()}`;
    const handle = await durableMulti.start(id, {});

    // Wait for 1s reminder to fire, then send event before 3s escalation
    await waitForContext(handle, (ctx) => ctx.reminders >= 1);
    await handle.send({ type: "RESPOND" });

    const result = await handle.getResult();
    // Reminder fired once, then event resolved the machine
    expect(result).toMatchObject({ reminders: 1 });
  });

  it("self-targeting after with reenter ticks multiple times", async () => {
    const id = `after-self-${Date.now()}`;
    const handle = await durableSelfTarget.start(id, {});

    // Wait for at least 2 ticks (each is 1s), then stop
    await waitForContext(handle, (ctx) => ctx.ticks >= 2, 15000);
    await handle.send({ type: "STOP" });

    const result = await handle.getResult();
    // Must have ticked at least twice — proves firedDelays resets on reenter
    expect((result as any).ticks).toBeGreaterThanOrEqual(2);
  });

  it("self-targeting after preserves tick count in final context", async () => {
    const id = `after-self-exact-${Date.now()}`;
    const handle = await durableSelfTarget.start(id, {});

    // Let it tick exactly 3 times (~3s), then stop
    await waitForContext(handle, (ctx) => ctx.ticks >= 3, 15000);
    await handle.send({ type: "STOP" });

    const result = await handle.getResult();
    expect((result as any).ticks).toBeGreaterThanOrEqual(3);
  });

  it("named delay resolves and fires correctly", async () => {
    const id = `after-named-${Date.now()}`;
    const handle = await durableNamed.start(id, {});

    const result = await handle.getResult();
    expect(result).toMatchObject({ expired: true });
  });

  it("named delay loses race to an event", async () => {
    const id = `after-named-race-${Date.now()}`;
    const handle = await durableNamed.start(id, {});

    await waitForState(handle, "waiting");
    await handle.send({ type: "RESPOND" });

    const result = await handle.getResult();
    expect(result).toMatchObject({ expired: false });
  });
});
