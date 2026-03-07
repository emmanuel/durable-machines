import { describe, it, expect, vi, beforeEach } from "vitest";
import { setup, fromPromise, assign } from "xstate";
import { durableState } from "../../src/durable-state.js";
import { prompt } from "../../src/prompt.js";
import {
  processStartup,
  processEvent,
  processTimeout,
} from "../../src/pg/event-processor.js";
import type { EventProcessorOptions } from "../../src/pg/event-processor.js";
import type { PgStore, MachineRow } from "../../src/pg/store.js";

// ─── Mock Store ─────────────────────────────────────────────────────────────

function createMockStore(): PgStore & {
  instances: Map<string, MachineRow>;
  invokeResults: Map<string, { output: unknown; error: unknown }>;
  transitions: Array<{ instanceId: string; from: unknown; to: unknown; event: string | null; ts: number }>;
} {
  const instances = new Map<string, MachineRow>();
  const invokeResults = new Map<string, { output: unknown; error: unknown }>();
  const transitions: Array<{ instanceId: string; from: unknown; to: unknown; event: string | null; ts: number }> = [];

  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };

  const store: any = {
    instances,
    invokeResults,
    transitions,
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
      row.updatedAt = Date.now();
    },

    async listInstances() {
      return [...instances.values()];
    },

    async lockAndGetInstance(_client: any, id: string) {
      return instances.get(id) ?? null;
    },

    async sendMessage() {},

    async consumeNextMessage() {
      return null;
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

  describe("processEvent", () => {
    it("transitions on external event", async () => {
      const deps: EventProcessorOptions = {
        store,
        machine: simpleMachine,
        options: {},
      };

      await processStartup(deps, "evt-1", { value: "test" });

      await processEvent(deps, "evt-1", { type: "GO" });

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

      await processEvent(deps, "evt-inv", { type: "START" });

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

      await processEvent(deps, "evt-err", { type: "START" });

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

      await processEvent(deps, "evt-cache", { type: "START" });

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

      await processEvent(deps, "evt-prompt-exit", { type: "APPROVE" });

      expect(channel.resolvePrompt).toHaveBeenCalled();
      const call = channel.resolvePrompt.mock.calls[0][0];
      expect(call.newStateValue).toBe("approved");
    });
  });

  describe("processTimeout", () => {
    it("fires correct after event based on firedDelays", async () => {
      const deps: EventProcessorOptions = {
        store,
        machine: afterMachine,
        options: {},
      };

      await processStartup(deps, "timeout-1", {});

      const row = store.instances.get("timeout-1");
      expect(row!.wakeAt).not.toBeNull();

      await processTimeout(deps, "timeout-1");

      const updated = store.instances.get("timeout-1");
      expect(updated!.stateValue).toBe("timedOut");
      expect(updated!.context).toMatchObject({ timedOut: true });
      expect(updated!.status).toBe("done");
    });
  });
});
