import { describe, it, expect, vi, beforeEach } from "vitest";
import { setup, fromPromise, assign } from "xstate";
import { durableState } from "../../src/durable-state.js";
import { prompt } from "../../src/prompt.js";
import {
  processStartup,
  processNextFromLog,
} from "../../src/pg/event-processor.js";
import type { EventProcessorOptions } from "../../src/pg/event-processor.js";
import type { PgStore, MachineRow } from "../../src/pg/store.js";

// ─── Mock Store ─────────────────────────────────────────────────────────────

function createMockStore(): PgStore & {
  instances: Map<string, MachineRow>;
  invokeResults: Map<string, { output: unknown; error: unknown }>;
  transitions: Array<{ instanceId: string; from: unknown; to: unknown; event: string | null; ts: number }>;
  eventLog: Map<string, Array<{ seq: number; payload: unknown; topic: string; source: string | null; createdAt: number }>>;
  nextSeq: number;
} {
  const instances = new Map<string, MachineRow>();
  const invokeResults = new Map<string, { output: unknown; error: unknown }>();
  const transitions: Array<{ instanceId: string; from: unknown; to: unknown; event: string | null; ts: number }> = [];
  const eventLog = new Map<string, Array<{ seq: number; payload: unknown; topic: string; source: string | null; createdAt: number }>>();
  let nextSeq = 1;

  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };

  const store: any = {
    instances,
    invokeResults,
    transitions,
    eventLog,
    get nextSeq() { return nextSeq; },
    _pool: {
      connect: vi.fn().mockResolvedValue(mockClient),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    },

    async ensureSchema() {},

    async createInstance(
      id: string,
      machineName: string,
      stateValue: unknown,
      context: Record<string, unknown>,
      input: Record<string, unknown> | null,
      wakeAt?: number | null,
      firedDelays?: Array<string | number>,
    ) {
      const now = Date.now();
      instances.set(id, {
        id,
        machineName,
        stateValue: stateValue as any,
        context,
        status: "running",
        firedDelays: firedDelays ?? [],
        wakeAt: wakeAt ?? null,
        input,
        eventCursor: 0,
        createdAt: now,
        updatedAt: now,
      });
    },

    async getInstance(id: string) {
      return instances.get(id) ?? null;
    },

    async updateInstance(
      id: string,
      patch: Record<string, unknown>,
      _queryable?: unknown,
    ) {
      const row = instances.get(id);
      if (!row) return;
      if (patch.stateValue !== undefined) row.stateValue = patch.stateValue as any;
      if (patch.context !== undefined) row.context = patch.context as any;
      if (patch.wakeAt !== undefined) row.wakeAt = patch.wakeAt as any;
      if (patch.firedDelays !== undefined) row.firedDelays = patch.firedDelays as any;
      if (patch.status !== undefined) row.status = patch.status as any;
      if (patch.eventCursor !== undefined) row.eventCursor = patch.eventCursor as number;
      row.updatedAt = Date.now();
    },

    async listInstances() {
      return [...instances.values()];
    },

    async lockAndGetInstance(_client: any, id: string) {
      return instances.get(id) ?? null;
    },

    async appendEvent(
      instanceId: string,
      payload: unknown,
      topic = "event",
      source?: string,
    ) {
      const seq = nextSeq++;
      const entries = eventLog.get(instanceId) ?? [];
      entries.push({ seq, payload, topic, source: source ?? null, createdAt: Date.now() });
      eventLog.set(instanceId, entries);
      return { seq };
    },

    async lockAndPeekEvent(_client: any, instanceId: string) {
      const row = instances.get(instanceId);
      if (!row) return null;
      const entries = eventLog.get(instanceId) ?? [];
      const next = entries.find((e) => e.seq > row.eventCursor);
      return {
        row,
        nextEvent: next ? { seq: next.seq, payload: next.payload } : null,
      };
    },

    async getEventLog(instanceId: string, opts?: { afterSeq?: number; limit?: number }) {
      let entries = eventLog.get(instanceId) ?? [];
      if (opts?.afterSeq !== undefined) {
        entries = entries.filter((e) => e.seq > opts.afterSeq!);
      }
      if (opts?.limit !== undefined) {
        entries = entries.slice(0, opts.limit);
      }
      return entries;
    },

    async getInvokeResult(instanceId: string, stepKey: string) {
      return invokeResults.get(`${instanceId}:${stepKey}`) ?? null;
    },

    async recordInvokeResult(
      instanceId: string,
      stepKey: string,
      output: unknown,
      error?: unknown,
    ) {
      const key = `${instanceId}:${stepKey}`;
      if (!invokeResults.has(key)) {
        invokeResults.set(key, { output, error: error ?? null });
      }
    },

    async listInvokeResults(instanceId: string) {
      const results: any[] = [];
      for (const [key, val] of invokeResults) {
        if (key.startsWith(`${instanceId}:`)) {
          results.push({
            name: key.slice(instanceId.length + 1),
            output: val.output,
            error: val.error,
          });
        }
      }
      return results;
    },

    async appendTransition(instanceId: string, from: unknown, to: unknown, event: string | null, ts: number) {
      transitions.push({ instanceId, from, to, event, ts });
    },

    async getTransitions(instanceId: string) {
      return transitions
        .filter((t) => t.instanceId === instanceId)
        .map((t) => ({ from: t.from, to: t.to, ts: t.ts }));
    },

    async startListening() {},
    async stopListening() {},
    async close() {},
  };

  return store;
}

// ─── Test Machines ──────────────────────────────────────────────────────────

const simpleMachine = setup({
  types: {
    context: {} as { value: string },
    events: {} as { type: "GO" },
    input: {} as { value: string },
  },
}).createMachine({
  id: "simple",
  initial: "idle",
  context: ({ input }) => ({ value: input.value }),
  states: {
    idle: {
      ...durableState(),
      on: { GO: "done" },
    },
    done: { type: "final" },
  },
});

const invokeMachine = setup({
  types: {
    context: {} as { result?: string },
    events: {} as { type: "START" },
    input: {} as Record<string, never>,
  },
  actors: {
    doWork: fromPromise(async () => {
      return { result: "worked" };
    }),
  },
}).createMachine({
  id: "invokeTest",
  initial: "waiting",
  context: {},
  states: {
    waiting: {
      ...durableState(),
      on: { START: "working" },
    },
    working: {
      invoke: {
        src: "doWork",
        input: () => ({}),
        onDone: {
          target: "complete",
          actions: assign({ result: ({ event }) => (event.output as any).result }),
        },
        onError: "failed",
      },
    },
    complete: { type: "final" },
    failed: { type: "final" },
  },
});

const failingInvokeMachine = setup({
  types: {
    context: {} as { error?: string },
    events: {} as { type: "START" },
    input: {} as Record<string, never>,
  },
  actors: {
    failWork: fromPromise(async () => {
      throw new Error("boom");
    }),
  },
}).createMachine({
  id: "failInvoke",
  initial: "waiting",
  context: {},
  states: {
    waiting: {
      ...durableState(),
      on: { START: "working" },
    },
    working: {
      invoke: {
        src: "failWork",
        onDone: "complete",
        onError: {
          target: "failed",
          actions: assign({ error: "caught" }),
        },
      },
    },
    complete: { type: "final" },
    failed: { type: "final" },
  },
});

const promptMachine = setup({
  types: {
    context: {} as { decision: string },
    events: {} as { type: "APPROVE" } | { type: "REJECT" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "promptTest",
  initial: "pending",
  context: { decision: "none" },
  states: {
    pending: {
      ...prompt({
        type: "choice",
        text: "Approve?",
        options: [
          { label: "Yes", event: "APPROVE" },
          { label: "No", event: "REJECT" },
        ],
      }),
      on: {
        APPROVE: { target: "approved", actions: assign({ decision: "yes" }) },
        REJECT: { target: "rejected", actions: assign({ decision: "no" }) },
      },
    },
    approved: { type: "final" },
    rejected: { type: "final" },
  },
});

const afterMachine = setup({
  types: {
    context: {} as { timedOut: boolean },
    events: {} as { type: "RESPOND" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "afterTest",
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("PG Event Processor", () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    store = createMockStore();
  });

  describe("processStartup", () => {
    it("creates instance with correct initial state", async () => {
      const deps: EventProcessorOptions = {
        store,
        machine: simpleMachine,
        options: {},
      };

      await processStartup(deps, "startup-1", { value: "hello" });

      const row = store.instances.get("startup-1");
      expect(row).toBeDefined();
      expect(row!.stateValue).toBe("idle");
      expect(row!.context).toMatchObject({ value: "hello" });
      expect(row!.status).toBe("running");
    });

    it("executes invocations inline during startup", async () => {
      // A machine that starts in an invoke state
      const autoInvokeMachine = setup({
        types: {
          context: {} as { result?: string },
          input: {} as Record<string, never>,
        },
        actors: {
          autoWork: fromPromise(async () => ({ result: "auto" })),
        },
      }).createMachine({
        id: "autoInvoke",
        initial: "working",
        context: {},
        states: {
          working: {
            invoke: {
              src: "autoWork",
              onDone: {
                target: "done",
                actions: assign({ result: ({ event }) => (event.output as any).result }),
              },
              onError: "failed",
            },
          },
          done: { type: "final" },
          failed: { type: "final" },
        },
      });

      const deps: EventProcessorOptions = {
        store,
        machine: autoInvokeMachine,
        options: {},
      };

      await processStartup(deps, "startup-inv", {});

      const row = store.instances.get("startup-inv");
      expect(row!.stateValue).toBe("done");
      expect(row!.context).toMatchObject({ result: "auto" });
    });

    it("records transition when enableTransitionStream is true", async () => {
      const deps: EventProcessorOptions = {
        store,
        machine: simpleMachine,
        options: {},
        enableTransitionStream: true,
      };

      await processStartup(deps, "startup-ts", { value: "v" });

      expect(store.transitions).toHaveLength(1);
      expect(store.transitions[0].from).toBeNull();
      expect(store.transitions[0].to).toBe("idle");
    });
  });

  describe("processNextFromLog", () => {
    it("transitions on external event", async () => {
      const deps: EventProcessorOptions = {
        store,
        machine: simpleMachine,
        options: {},
      };

      await processStartup(deps, "evt-1", { value: "test" });
      await store.appendEvent("evt-1", { type: "GO" });

      await processNextFromLog(deps, "evt-1");

      const row = store.instances.get("evt-1");
      expect(row!.stateValue).toBe("done");
      expect(row!.status).toBe("done");
    });

    it("executes invocation and transitions on done", async () => {
      const deps: EventProcessorOptions = {
        store,
        machine: invokeMachine,
        options: {},
      };

      await processStartup(deps, "evt-inv", {});
      await store.appendEvent("evt-inv", { type: "START" });

      await processNextFromLog(deps, "evt-inv");

      const row = store.instances.get("evt-inv");
      expect(row!.stateValue).toBe("complete");
      expect(row!.context).toMatchObject({ result: "worked" });
    });

    it("captures invocation error and transitions on error", async () => {
      const deps: EventProcessorOptions = {
        store,
        machine: failingInvokeMachine,
        options: {},
      };

      await processStartup(deps, "evt-err", {});
      await store.appendEvent("evt-err", { type: "START" });

      await processNextFromLog(deps, "evt-err");

      const row = store.instances.get("evt-err");
      expect(row!.stateValue).toBe("failed");
      expect(row!.context).toMatchObject({ error: "caught" });
    });

    it("skips invocation when cached result exists", async () => {
      const deps: EventProcessorOptions = {
        store,
        machine: invokeMachine,
        options: {},
      };

      await processStartup(deps, "evt-cache", {});

      // Pre-cache the invoke result
      store.invokeResults.set(`evt-cache:invoke:doWork`, {
        output: { result: "cached" },
        error: null,
      });

      await store.appendEvent("evt-cache", { type: "START" });
      await processNextFromLog(deps, "evt-cache");

      const row = store.instances.get("evt-cache");
      expect(row!.stateValue).toBe("complete");
      expect(row!.context).toMatchObject({ result: "cached" });
    });

    it("sends prompt on entry to prompt state", async () => {
      const channel = {
        sendPrompt: vi.fn().mockResolvedValue({ handle: "h1" }),
        resolvePrompt: vi.fn().mockResolvedValue(undefined),
      };

      const deps: EventProcessorOptions = {
        store,
        machine: promptMachine,
        options: { channels: [channel] },
      };

      await processStartup(deps, "evt-prompt", {});

      // The prompt state is the initial state
      expect(channel.sendPrompt).toHaveBeenCalled();
      const call = channel.sendPrompt.mock.calls[0][0];
      expect(call.prompt.type).toBe("choice");
      expect(call.prompt.text).toBe("Approve?");
    });

    it("resolves prompt on exit from prompt state", async () => {
      const channel = {
        sendPrompt: vi.fn().mockResolvedValue({ handle: "h1" }),
        resolvePrompt: vi.fn().mockResolvedValue(undefined),
      };

      const deps: EventProcessorOptions = {
        store,
        machine: promptMachine,
        options: { channels: [channel] },
      };

      await processStartup(deps, "evt-prompt-exit", {});

      await store.appendEvent("evt-prompt-exit", { type: "APPROVE" });
      await processNextFromLog(deps, "evt-prompt-exit");

      expect(channel.resolvePrompt).toHaveBeenCalled();
      const call = channel.resolvePrompt.mock.calls[0][0];
      expect(call.newStateValue).toBe("approved");
    });

    it("returns false when no unconsumed events", async () => {
      const deps: EventProcessorOptions = {
        store,
        machine: simpleMachine,
        options: {},
      };

      await processStartup(deps, "evt-empty", { value: "test" });

      const processed = await processNextFromLog(deps, "evt-empty");
      expect(processed).toBe(false);
    });

    it("advances event cursor after processing", async () => {
      const deps: EventProcessorOptions = {
        store,
        machine: simpleMachine,
        options: {},
      };

      await processStartup(deps, "evt-cursor", { value: "test" });
      const { seq } = await store.appendEvent("evt-cursor", { type: "GO" });

      await processNextFromLog(deps, "evt-cursor");

      const row = store.instances.get("evt-cursor");
      expect(row!.eventCursor).toBe(seq);
    });

    it("does not persist final state when cancelled during invocation", async () => {
      // Use a slow invocation to simulate cancellation during execution
      const slowMachine = setup({
        types: {
          context: {} as { result?: string },
          events: {} as { type: "START" },
          input: {} as Record<string, never>,
        },
        actors: {
          slowWork: fromPromise(async () => {
            // During this invocation, we'll set status to cancelled
            const inst = store.instances.get("evt-cancel");
            if (inst) inst.status = "cancelled";
            return { result: "done" };
          }),
        },
      }).createMachine({
        id: "slowInvoke",
        initial: "waiting",
        context: {},
        states: {
          waiting: {
            ...durableState(),
            on: { START: "working" },
          },
          working: {
            invoke: {
              src: "slowWork",
              input: () => ({}),
              onDone: {
                target: "complete",
                actions: assign({ result: ({ event }) => (event.output as any).result }),
              },
              onError: "failed",
            },
          },
          complete: { type: "final" },
          failed: { type: "final" },
        },
      });

      const deps: EventProcessorOptions = {
        store,
        machine: slowMachine,
        options: {},
      };

      await processStartup(deps, "evt-cancel", {});
      await store.appendEvent("evt-cancel", { type: "START" });
      await processNextFromLog(deps, "evt-cancel");

      const row = store.instances.get("evt-cancel");
      // Should stay cancelled — final state should not be persisted
      expect(row!.status).toBe("cancelled");
      expect(row!.stateValue).toBe("working");
    });

    it("persists intermediate invoking state before executing invocation", async () => {
      let stateValueDuringInvoke: unknown;

      const spyMachine = setup({
        types: {
          context: {} as { result?: string },
          events: {} as { type: "START" },
          input: {} as Record<string, never>,
        },
        actors: {
          spyWork: fromPromise(async () => {
            // Capture the persisted state during invocation
            const inst = store.instances.get("evt-spy");
            stateValueDuringInvoke = inst?.stateValue;
            return { result: "spied" };
          }),
        },
      }).createMachine({
        id: "spyInvoke",
        initial: "waiting",
        context: {},
        states: {
          waiting: {
            ...durableState(),
            on: { START: "working" },
          },
          working: {
            invoke: {
              src: "spyWork",
              input: () => ({}),
              onDone: {
                target: "complete",
                actions: assign({ result: ({ event }) => (event.output as any).result }),
              },
              onError: "failed",
            },
          },
          complete: { type: "final" },
          failed: { type: "final" },
        },
      });

      const deps: EventProcessorOptions = {
        store,
        machine: spyMachine,
        options: {},
      };

      await processStartup(deps, "evt-spy", {});
      await store.appendEvent("evt-spy", { type: "START" });
      await processNextFromLog(deps, "evt-spy");

      // During invocation, state should have been persisted as "working"
      expect(stateValueDuringInvoke).toBe("working");
      // After completion, final state should be "complete"
      const row = store.instances.get("evt-spy");
      expect(row!.stateValue).toBe("complete");
      expect(row!.status).toBe("done");
    });

    it("does not advance cursor in Txn 1 when invocation is detected", async () => {
      let cursorDuringInvoke: number | undefined;

      const cursorSpyMachine = setup({
        types: {
          context: {} as { result?: string },
          events: {} as { type: "START" },
          input: {} as Record<string, never>,
        },
        actors: {
          cursorWork: fromPromise(async () => {
            const inst = store.instances.get("evt-cursor-inv");
            cursorDuringInvoke = inst?.eventCursor;
            return { result: "ok" };
          }),
        },
      }).createMachine({
        id: "cursorInvoke",
        initial: "waiting",
        context: {},
        states: {
          waiting: {
            ...durableState(),
            on: { START: "working" },
          },
          working: {
            invoke: {
              src: "cursorWork",
              input: () => ({}),
              onDone: {
                target: "complete",
                actions: assign({ result: ({ event }) => (event.output as any).result }),
              },
              onError: "failed",
            },
          },
          complete: { type: "final" },
          failed: { type: "final" },
        },
      });

      const deps: EventProcessorOptions = {
        store,
        machine: cursorSpyMachine,
        options: {},
      };

      await processStartup(deps, "evt-cursor-inv", {});
      const { seq } = await store.appendEvent("evt-cursor-inv", { type: "START" });
      await processNextFromLog(deps, "evt-cursor-inv");

      // During invocation, cursor should NOT have been advanced
      expect(cursorDuringInvoke).toBe(0);
      // After completion, cursor should be advanced
      const row = store.instances.get("evt-cursor-inv");
      expect(row!.eventCursor).toBe(seq);
    });

    it("fires correct after event via event log", async () => {
      const deps: EventProcessorOptions = {
        store,
        machine: afterMachine,
        options: {},
      };

      await processStartup(deps, "timeout-1", {});

      const row = store.instances.get("timeout-1");
      expect(row!.wakeAt).not.toBeNull();

      // Simulate timeout by appending an after event to the log
      const { buildAfterEvent, getSortedAfterDelays } = await import("../../src/xstate-utils.js");
      const snapshot = afterMachine.resolveState({ value: row!.stateValue, context: row!.context });
      const delays = getSortedAfterDelays(afterMachine, snapshot);
      const afterEvent = buildAfterEvent(afterMachine, snapshot, delays[0]);
      await store.appendEvent("timeout-1", afterEvent, "timeout", "system:timeout");

      await processNextFromLog(deps, "timeout-1");

      const updated = store.instances.get("timeout-1");
      expect(updated!.stateValue).toBe("timedOut");
      expect(updated!.context).toMatchObject({ timedOut: true });
      expect(updated!.status).toBe("done");
    });
  });
});
