import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AnyStateMachine } from "xstate";
import type { PgStore } from "@durable-xstate/durable-machine/pg";
import type { PgDurableMachine } from "@durable-xstate/durable-machine/pg";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock pg module — must be before the import of lifecycle.ts
const mockPoolEnd = vi.fn().mockResolvedValue(undefined);
const mockPoolQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockPool = {
  query: mockPoolQuery,
  end: mockPoolEnd,
  connect: vi.fn(),
};

vi.mock("pg", () => ({
  Pool: vi.fn(function () {
    return mockPool;
  }),
}));

// Mock createStore
const mockEnsureSchema = vi.fn().mockResolvedValue(undefined);
const mockStartListening = vi.fn().mockResolvedValue(undefined);
const mockStopListening = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

const mockAppendEvent = vi.fn().mockResolvedValue({ seq: 1 });

const mockStore: PgStore = {
  ensureSchema: mockEnsureSchema,
  startListening: mockStartListening,
  stopListening: mockStopListening,
  close: mockClose,
  createInstance: vi.fn(),
  getInstance: vi.fn(),
  updateInstanceStatus: vi.fn(),
  updateInstanceSnapshot: vi.fn(),
  listInstances: vi.fn(),
  lockAndGetInstance: vi.fn(),
  appendEvent: mockAppendEvent,
  lockAndPeekEvent: vi.fn(),
  lockAndPeekEvents: vi.fn(),
  getEventLog: vi.fn().mockResolvedValue([]),
  getInvokeResult: vi.fn(),
  recordInvokeResult: vi.fn(),
  listInvokeResults: vi.fn(),
  finalizeInstance: vi.fn(),
  finalizeWithTransition: vi.fn(),
  appendTransition: vi.fn(),
  getTransitions: vi.fn(),
  insertEffects: vi.fn(),
  claimPendingEffects: vi.fn().mockResolvedValue([]),
  markEffectCompleted: vi.fn(),
  markEffectFailed: vi.fn(),
  listEffects: vi.fn().mockResolvedValue([]),
};

vi.mock("@durable-xstate/durable-machine/pg", async () => {
  const actual = await vi.importActual("@durable-xstate/durable-machine/pg");
  return {
    ...actual,
    createStore: vi.fn(() => mockStore),
    createDurableMachine: vi.fn((machine: AnyStateMachine) => {
      lastCreatedMachine = makeMockDurableMachine(machine);
      return lastCreatedMachine;
    }),
  };
});

// Mock createAppContext — pass-through to real implementation for lifecycle tests
vi.mock("@durable-xstate/durable-machine", async () => {
  return await vi.importActual("@durable-xstate/durable-machine");
});

// ─── Mock helpers ────────────────────────────────────────────────────────────

function makeMockDurableMachine(machine: AnyStateMachine): PgDurableMachine {
  return {
    machine,
    start: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    consumeAndProcess: mockConsumeAndProcess,
  };
}

const mockConsumeAndProcess = vi.fn().mockResolvedValue(undefined);
let lastCreatedMachine: PgDurableMachine | null = null;

// ─── Import after mocks ─────────────────────────────────────────────────────

import { createPgWorkerContext } from "../../../src/pg/lifecycle.js";

// ─── Fake machines ──────────────────────────────────────────────────────────

function fakeMachine(id: string): AnyStateMachine {
  return { id } as unknown as AnyStateMachine;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type SignalHandler = (...args: unknown[]) => void;
let listeners: Map<string, SignalHandler[]>;

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  lastCreatedMachine = null;

  listeners = new Map();
  vi.spyOn(process, "on").mockImplementation(
    (event: string | symbol, handler: (...args: any[]) => void) => {
      const key = typeof event === "symbol" ? event.toString() : event;
      const list = listeners.get(key) ?? [];
      list.push(handler);
      listeners.set(key, list);
      return process;
    },
  );

  vi.spyOn(process, "exit").mockImplementation(
    (_code?: string | number | null) => undefined as never,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createPgWorkerContext", () => {
  // ── Registration ─────────────────────────────────────────────────────────

  describe("register()", () => {
    it("returns DurableMachine with correct .machine ref", () => {
      const ctx = createPgWorkerContext({ databaseUrl: "postgres://localhost/test" });
      const m = fakeMachine("order");

      const dm = ctx.register(m);

      expect(dm.machine).toBe(m);
    });

    it("throws on duplicate machine ID", () => {
      const ctx = createPgWorkerContext({ databaseUrl: "postgres://localhost/test" });
      const m = fakeMachine("order");

      ctx.register(m);

      expect(() => ctx.register(m)).toThrow('Machine "order" is already registered');
    });

    it("works both before and after start()", async () => {
      const ctx = createPgWorkerContext({ databaseUrl: "postgres://localhost/test" });
      const m1 = fakeMachine("before");
      const m2 = fakeMachine("after");

      // Before start
      const dm1 = ctx.register(m1);
      expect(dm1.machine).toBe(m1);

      await ctx.start({ handleExceptions: false, signals: [] });

      // After start
      const dm2 = ctx.register(m2);
      expect(dm2.machine).toBe(m2);
    });

    it("exposes pool and store on the returned context", () => {
      const ctx = createPgWorkerContext({ databaseUrl: "postgres://localhost/test" });

      expect(ctx.pool).toBe(mockPool);
      expect(ctx.store).toBe(mockStore);
    });
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("start() calls store.ensureSchema()", async () => {
      const ctx = createPgWorkerContext({ databaseUrl: "postgres://localhost/test" });

      await ctx.start({ handleExceptions: false, signals: [] });

      expect(mockEnsureSchema).toHaveBeenCalledOnce();
    });

    it("start() calls store.startListening() with a 3-arg callback", async () => {
      const ctx = createPgWorkerContext({ databaseUrl: "postgres://localhost/test" });

      await ctx.start({ handleExceptions: false, signals: [] });

      expect(mockStartListening).toHaveBeenCalledOnce();
      const cb = mockStartListening.mock.calls[0][0];
      expect(typeof cb).toBe("function");
      expect(cb.length).toBe(3);
    });

    it("start() starts the wake poller and effect poller (setTimeout called for adaptive polling)", async () => {
      const stSpy = vi.spyOn(globalThis, "setTimeout");
      const ctx = createPgWorkerContext({ databaseUrl: "postgres://localhost/test" });

      const beforeCount = stSpy.mock.calls.length;
      await ctx.start({ handleExceptions: false, signals: [] });

      // Adaptive polling uses setTimeout — at least 2 calls (one per poller)
      expect(stSpy.mock.calls.length - beforeCount).toBeGreaterThanOrEqual(2);
    });

    it("shutdown stops poller, then store.close(), then pool.end() (in order)", async () => {
      const ctx = createPgWorkerContext({ databaseUrl: "postgres://localhost/test" });

      await ctx.start({ handleExceptions: false, signals: [] });

      const callOrder: string[] = [];
      mockClose.mockImplementation(async () => {
        callOrder.push("store.close");
      });
      mockPoolEnd.mockImplementation(async () => {
        callOrder.push("pool.end");
      });

      void ctx.shutdown("test");
      await vi.advanceTimersByTimeAsync(0);

      // store.close before pool.end
      expect(callOrder).toEqual(["store.close", "pool.end"]);

      // Poller should no longer fire after shutdown
      mockPoolQuery.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it("isShuttingDown() is false before shutdown, true after", async () => {
      const ctx = createPgWorkerContext({ databaseUrl: "postgres://localhost/test" });

      await ctx.start({ handleExceptions: false, signals: [] });
      expect(ctx.isShuttingDown()).toBe(false);

      void ctx.shutdown("test");
      await vi.advanceTimersByTimeAsync(0);

      expect(ctx.isShuttingDown()).toBe(true);
    });
  });

  // ── Fan-out ──────────────────────────────────────────────────────────────

  describe("LISTEN fan-out", () => {
    it("dispatches to correct machine's consumeAndProcess() by name", async () => {
      const ctx = createPgWorkerContext({ databaseUrl: "postgres://localhost/test" });
      const m = fakeMachine("order");
      ctx.register(m);

      await ctx.start({ handleExceptions: false, signals: [] });

      const cb = mockStartListening.mock.calls[0][0] as (
        machineName: string,
        instanceId: string,
        topic: string,
      ) => void;

      cb("order", "inst-1", "event");

      // consumeAndProcess is called via void (fire-and-forget), wait for microtask
      await vi.advanceTimersByTimeAsync(0);

      expect(lastCreatedMachine!.consumeAndProcess).toHaveBeenCalledWith("inst-1");
    });

    it("dispatches for any topic (event, timeout, etc.)", async () => {
      const ctx = createPgWorkerContext({ databaseUrl: "postgres://localhost/test" });
      const m = fakeMachine("order");
      ctx.register(m);

      await ctx.start({ handleExceptions: false, signals: [] });

      const cb = mockStartListening.mock.calls[0][0] as (
        machineName: string,
        instanceId: string,
        topic: string,
      ) => void;

      cb("order", "inst-1", "timeout");
      await vi.advanceTimersByTimeAsync(0);

      expect(mockConsumeAndProcess).toHaveBeenCalledWith("inst-1");
    });

    it("ignores unknown machine names (no throw)", async () => {
      const ctx = createPgWorkerContext({ databaseUrl: "postgres://localhost/test" });

      await ctx.start({ handleExceptions: false, signals: [] });

      const cb = mockStartListening.mock.calls[0][0] as (
        machineName: string,
        instanceId: string,
        topic: string,
      ) => void;

      // Should not throw
      expect(() => cb("unknown", "inst-1", "event")).not.toThrow();
    });
  });

  // ── Poller ───────────────────────────────────────────────────────────────

  describe("wake poller", () => {
    it("survives query failures", async () => {
      const ctx = createPgWorkerContext({
        databaseUrl: "postgres://localhost/test",
        wakePollingIntervalMs: 1000,
      });
      const m = fakeMachine("order");
      ctx.register(m);

      // First tick: query fails
      mockPoolQuery.mockRejectedValueOnce(new Error("connection refused"));

      await ctx.start({ handleExceptions: false, signals: [] });
      await vi.advanceTimersByTimeAsync(1000);

      // Second tick: no rows returned (default mock behavior)
      await vi.advanceTimersByTimeAsync(1000);

      // No error — poller survives
    });
  });
});
