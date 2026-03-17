import { describe, it, expect, vi, beforeEach } from "vitest";
import { createNativeDurableMachine } from "../../../src/pg-native/create-durable-machine.js";
import type { PgNativeDurableMachineOptions } from "../../../src/pg-native/types.js";
import type { PgStore } from "../../../src/pg/store-types.js";
import type { MachineRow } from "../../../src/pg/store-types.js";
import type { MachineDefinition } from "../../../src/definition/types.js";
import { DurableMachineError } from "../../../src/types.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TEST_MACHINE_NAME = "test-machine";
const TEST_WORKFLOW_ID = "wf-001";

const MOCK_DEFINITION: MachineDefinition = {
  id: "test-machine",
  initial: "idle",
  states: {
    idle: { on: { START: "running" } },
    running: { on: { DONE: "finished" } },
    finished: { type: "final" },
  },
} as MachineDefinition;

function makeMachineRow(overrides: Partial<MachineRow> = {}): MachineRow {
  return {
    id: TEST_WORKFLOW_ID,
    tenantId: "tenant-0",
    machineName: TEST_MACHINE_NAME,
    stateValue: "idle",
    context: { count: 0 },
    status: "running",
    firedDelays: [],
    wakeAt: null,
    wakeEvent: null,
    input: {},
    eventCursor: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ─── Mock Factories ─────────────────────────────────────────────────────────

function createMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  } as any;
}

function createMockStore(): PgStore {
  return {
    withTransaction: vi.fn(),
    ensureSchema: vi.fn(),
    ensureRoles: vi.fn(),
    createInstance: vi.fn(),
    getInstance: vi.fn().mockResolvedValue(null),
    updateInstanceStatus: vi.fn(),
    updateInstanceSnapshot: vi.fn(),
    listInstances: vi.fn().mockResolvedValue([]),
    lockAndGetInstance: vi.fn(),
    appendEvent: vi.fn().mockResolvedValue({ seq: 1 }),
    lockAndPeekEvent: vi.fn(),
    lockAndPeekEvents: vi.fn(),
    getEventLog: vi.fn().mockResolvedValue([]),
    getInvokeResult: vi.fn().mockResolvedValue(null),
    recordInvokeResult: vi.fn(),
    listInvokeResults: vi.fn().mockResolvedValue([]),
    finalizeInstance: vi.fn(),
    finalizeWithTransition: vi.fn(),
    appendTransition: vi.fn(),
    getTransitions: vi.fn().mockResolvedValue([]),
    insertEffects: vi.fn(),
    claimPendingEffects: vi.fn().mockResolvedValue([]),
    markEffectCompleted: vi.fn(),
    markEffectFailed: vi.fn(),
    listEffects: vi.fn().mockResolvedValue([]),
    resetStaleEffects: vi.fn().mockResolvedValue(0),
    getStateDurations: vi.fn().mockResolvedValue([]),
    getAggregateStateDurations: vi.fn().mockResolvedValue([]),
    getTransitionCounts: vi.fn().mockResolvedValue([]),
    getInstanceSummaries: vi.fn().mockResolvedValue([]),
    startListening: vi.fn(),
    stopListening: vi.fn(),
    forTenant: vi.fn(),
    close: vi.fn(),
  } as unknown as PgStore;
}

function createOptions(
  pool: ReturnType<typeof createMockPool>,
  store: PgStore,
  definition?: MachineDefinition,
): PgNativeDurableMachineOptions {
  return {
    pool,
    store,
    machineName: TEST_MACHINE_NAME,
    definition,
  };
}

// ─── Helper: find pool.query calls by prepared statement name ────────────

function queryCallsByName(
  pool: ReturnType<typeof createMockPool>,
  name: string,
) {
  return pool.query.mock.calls.filter(
    (call: any[]) => call[0]?.name === name,
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createNativeDurableMachine", () => {
  let pool: ReturnType<typeof createMockPool>;
  let store: PgStore;

  beforeEach(() => {
    pool = createMockPool();
    store = createMockStore();
  });

  // ── 1. registerDefinition ─────────────────────────────────────────────

  describe("registerDefinition()", () => {
    it("calls dm_reg_definition with correct args", async () => {
      const dm = createNativeDurableMachine(
        createOptions(pool, store),
      );

      await dm.registerDefinition(MOCK_DEFINITION);

      const calls = queryCallsByName(pool, "dm_reg_definition");
      expect(calls).toHaveLength(1);
      expect(calls[0][0].values).toEqual([
        TEST_MACHINE_NAME,
        JSON.stringify(MOCK_DEFINITION),
      ]);
    });
  });

  // ── 2. start() ────────────────────────────────────────────────────────

  describe("start()", () => {
    it("registers definition (if provided) then calls dm_create_instance", async () => {
      pool.query.mockResolvedValue({
        rows: [
          {
            dm_create_instance: {
              status: "running",
              invocation: null,
            },
          },
        ],
      });

      const dm = createNativeDurableMachine(
        createOptions(pool, store, MOCK_DEFINITION),
      );

      const handle = await dm.start(TEST_WORKFLOW_ID, { foo: "bar" });

      // First call: register definition
      const regCalls = queryCallsByName(pool, "dm_reg_definition");
      expect(regCalls.length).toBeGreaterThanOrEqual(1);

      // Second call: create instance
      const createCalls = queryCallsByName(pool, "dm_native_create_instance");
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0][0].values).toEqual([
        TEST_WORKFLOW_ID,
        TEST_MACHINE_NAME,
        JSON.stringify({ foo: "bar" }),
        null,
      ]);

      // Returns a handle with the correct workflowId
      expect(handle.workflowId).toBe(TEST_WORKFLOW_ID);
    });

    it("skips registration when no definition is provided", async () => {
      pool.query.mockResolvedValue({
        rows: [
          {
            dm_create_instance: {
              status: "running",
              invocation: null,
            },
          },
        ],
      });

      const dm = createNativeDurableMachine(
        createOptions(pool, store), // no definition
      );

      await dm.start(TEST_WORKFLOW_ID, {});

      const regCalls = queryCallsByName(pool, "dm_reg_definition");
      expect(regCalls).toHaveLength(0);

      const createCalls = queryCallsByName(pool, "dm_native_create_instance");
      expect(createCalls).toHaveLength(1);
    });

    // ── 3. start() with invocation ────────────────────────────────────

    it("handles invocation on create: calls handleInvocation then consumeAndProcess", async () => {
      const invocation = { id: "actor-1", src: "fetchData", input: {} };

      // First call: dm_reg_definition (auto-register)
      // Second call: dm_native_create_instance -> returns invocation
      // Third call: dm_native_process_events -> returns processed=0 (from consumeAndProcess after invocation)
      pool.query.mockImplementation(async (config: any) => {
        if (config.name === "dm_reg_definition") {
          return { rows: [] };
        }
        if (config.name === "dm_native_create_instance") {
          return {
            rows: [
              {
                dm_create_instance: {
                  status: "running",
                  invocation,
                },
              },
            ],
          };
        }
        if (config.name === "dm_native_process_events") {
          return {
            rows: [
              {
                dm_process_events: {
                  processed: 0,
                  status: "running",
                  invocation: null,
                },
              },
            ],
          };
        }
        return { rows: [] };
      });

      const dm = createNativeDurableMachine(
        createOptions(pool, store, MOCK_DEFINITION),
      );

      await dm.start(TEST_WORKFLOW_ID, {});

      // handleInvocation checks for cached result (crash recovery)
      expect(store.getInvokeResult).toHaveBeenCalledWith(
        TEST_WORKFLOW_ID,
        "actor-1",
      );

      // handleInvocation records the invoke result
      expect(store.recordInvokeResult).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: TEST_WORKFLOW_ID,
          stepKey: "actor-1",
        }),
      );

      // handleInvocation injects result event
      expect(store.appendEvent).toHaveBeenCalledWith(
        TEST_WORKFLOW_ID,
        expect.objectContaining({
          type: expect.stringMatching(/^xstate\.(error|done)\.actor\.actor-1$/),
        }),
        "event",
        "system:invocation",
      );

      // consumeAndProcess was called after invocation handling
      const processCalls = queryCallsByName(pool, "dm_native_process_events");
      expect(processCalls.length).toBeGreaterThanOrEqual(1);
    });

    // ── 4. start() wraps 23505 into ALREADY_EXISTS ────────────────────

    it("wraps PostgreSQL 23505 unique violation into ALREADY_EXISTS error", async () => {
      const pgError = new Error("duplicate key value") as any;
      pgError.code = "23505";

      pool.query.mockImplementation(async (config: any) => {
        if (config.name === "dm_native_create_instance") {
          throw pgError;
        }
        return { rows: [] };
      });

      const dm = createNativeDurableMachine(createOptions(pool, store));

      await expect(
        dm.start(TEST_WORKFLOW_ID, {}),
      ).rejects.toThrow(DurableMachineError);

      try {
        await dm.start(TEST_WORKFLOW_ID, {});
      } catch (err) {
        expect(err).toBeInstanceOf(DurableMachineError);
        expect((err as DurableMachineError).code).toBe("ALREADY_EXISTS");
      }
    });
  });

  // ── 5. send() ─────────────────────────────────────────────────────────

  describe("send()", () => {
    it("appends event then calls dm_process_events", async () => {
      pool.query.mockResolvedValue({
        rows: [
          {
            dm_process_events: {
              processed: 0,
              status: "running",
              invocation: null,
            },
          },
        ],
      });

      const dm = createNativeDurableMachine(createOptions(pool, store));
      const handle = dm.get(TEST_WORKFLOW_ID);

      await handle.send({ type: "NEXT" });

      // store.appendEvent was called with the event
      expect(store.appendEvent).toHaveBeenCalledWith(TEST_WORKFLOW_ID, {
        type: "NEXT",
      });

      // pool.query was called with dm_native_process_events
      const processCalls = queryCallsByName(pool, "dm_native_process_events");
      expect(processCalls).toHaveLength(1);
      expect(processCalls[0][0].values).toEqual([TEST_WORKFLOW_ID, 50]);
    });
  });

  // ── 6. consumeAndProcess() loops until processed === 0 ────────────────

  describe("consumeAndProcess()", () => {
    it("loops until processed === 0", async () => {
      let callCount = 0;
      pool.query.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            rows: [
              {
                dm_process_events: {
                  processed: 5,
                  status: "running",
                  invocation: null,
                },
              },
            ],
          };
        }
        return {
          rows: [
            {
              dm_process_events: {
                processed: 0,
                status: "running",
                invocation: null,
              },
            },
          ],
        };
      });

      const dm = createNativeDurableMachine(createOptions(pool, store));
      await dm.consumeAndProcess(TEST_WORKFLOW_ID);

      const processCalls = queryCallsByName(pool, "dm_native_process_events");
      expect(processCalls).toHaveLength(2);
    });

    // ── 7. consumeAndProcess() handles invocation mid-loop ──────────────

    it("handles invocation mid-loop", async () => {
      const invocation = { id: "step-x", src: "doSomething", input: {} };
      let callCount = 0;

      pool.query.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First round: invocation needed
          return {
            rows: [
              {
                dm_process_events: {
                  processed: 1,
                  status: "running",
                  invocation,
                },
              },
            ],
          };
        }
        // Second round: no more events
        return {
          rows: [
            {
              dm_process_events: {
                processed: 0,
                status: "running",
                invocation: null,
              },
            },
          ],
        };
      });

      const dm = createNativeDurableMachine(createOptions(pool, store));
      await dm.consumeAndProcess(TEST_WORKFLOW_ID);

      // handleInvocation was called (checks crash-recovery cache)
      expect(store.getInvokeResult).toHaveBeenCalledWith(
        TEST_WORKFLOW_ID,
        "step-x",
      );

      // handleInvocation recorded the result
      expect(store.recordInvokeResult).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: TEST_WORKFLOW_ID,
          stepKey: "step-x",
        }),
      );

      // handleInvocation injected an error event (since no actor handler exists)
      expect(store.appendEvent).toHaveBeenCalledWith(
        TEST_WORKFLOW_ID,
        expect.objectContaining({
          type: "xstate.error.actor.step-x",
        }),
        "event",
        "system:invocation",
      );

      // Loop continued after invocation
      const processCalls = queryCallsByName(pool, "dm_native_process_events");
      expect(processCalls).toHaveLength(2);
    });
  });

  // ── 8. getState() ─────────────────────────────────────────────────────

  describe("getState()", () => {
    it("delegates to store.getInstance and maps to snapshot", async () => {
      const row = makeMachineRow({
        stateValue: "processing",
        context: { items: [1, 2] },
        status: "running",
      });
      (store.getInstance as ReturnType<typeof vi.fn>).mockResolvedValue(row);

      const dm = createNativeDurableMachine(createOptions(pool, store));
      const handle = dm.get(TEST_WORKFLOW_ID);
      const state = await handle.getState();

      expect(store.getInstance).toHaveBeenCalledWith(TEST_WORKFLOW_ID);
      expect(state).toEqual({
        value: "processing",
        context: { items: [1, 2] },
        status: "running",
      });
    });

    it("returns null when instance not found", async () => {
      (store.getInstance as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const dm = createNativeDurableMachine(createOptions(pool, store));
      const handle = dm.get(TEST_WORKFLOW_ID);
      const state = await handle.getState();

      expect(state).toBeNull();
    });
  });

  // ── 9. Delegation: getTransitions, listEffects, getEventLog ───────────

  describe("handle delegation methods", () => {
    it("getTransitions() delegates to store.getTransitions", async () => {
      const transitions = [
        { from: null, to: "idle", event: null, ts: 1000 },
      ];
      (store.getTransitions as ReturnType<typeof vi.fn>).mockResolvedValue(
        transitions,
      );

      const dm = createNativeDurableMachine(createOptions(pool, store));
      const handle = dm.get(TEST_WORKFLOW_ID);
      const result = await handle.getTransitions();

      expect(store.getTransitions).toHaveBeenCalledWith(TEST_WORKFLOW_ID);
      expect(result).toEqual(transitions);
    });

    it("listEffects() delegates to store.listEffects", async () => {
      const effectRows = [
        {
          id: "eff-1",
          instanceId: TEST_WORKFLOW_ID,
          stateValue: "active",
          effectType: "notify",
          effectPayload: { channel: "email" },
          status: "pending" as const,
          attempts: 0,
          maxAttempts: 3,
          lastError: null,
          createdAt: 1000,
          completedAt: null,
        },
      ];
      (store.listEffects as ReturnType<typeof vi.fn>).mockResolvedValue(
        effectRows,
      );

      const dm = createNativeDurableMachine(createOptions(pool, store));
      const handle = dm.get(TEST_WORKFLOW_ID);
      const result = await handle.listEffects();

      expect(store.listEffects).toHaveBeenCalledWith(TEST_WORKFLOW_ID);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "eff-1",
        effectType: "notify",
        status: "pending",
      });
    });

    it("getEventLog() delegates to store.getEventLog", async () => {
      const events = [
        { seq: 1, topic: "event", payload: { type: "START" }, source: null, createdAt: 1000 },
      ];
      (store.getEventLog as ReturnType<typeof vi.fn>).mockResolvedValue(
        events,
      );

      const dm = createNativeDurableMachine(createOptions(pool, store));
      const handle = dm.get(TEST_WORKFLOW_ID);
      const result = await handle.getEventLog({ afterSeq: 0, limit: 10 });

      expect(store.getEventLog).toHaveBeenCalledWith(TEST_WORKFLOW_ID, {
        afterSeq: 0,
        limit: 10,
      });
      expect(result).toEqual(events);
    });
  });

  // ── 10. list() ────────────────────────────────────────────────────────

  describe("list()", () => {
    it("delegates to store.listInstances with machineName filter", async () => {
      const rows = [
        makeMachineRow({ id: "wf-1", status: "running" }),
        makeMachineRow({ id: "wf-2", status: "done" }),
      ];
      (store.listInstances as ReturnType<typeof vi.fn>).mockResolvedValue(rows);

      const dm = createNativeDurableMachine(createOptions(pool, store));
      const result = await dm.list({ status: "running" });

      expect(store.listInstances).toHaveBeenCalledWith({
        machineName: TEST_MACHINE_NAME,
        status: "running",
      });

      // Result is mapped through rowToStatus
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        workflowId: "wf-1",
        status: "running",
        workflowName: TEST_MACHINE_NAME,
      });
    });
  });

  // ── 11. forTenant() ───────────────────────────────────────────────────

  describe("forTenant()", () => {
    it("creates a tenant-scoped instance via store.forTenant", () => {
      const tenantStore = createMockStore();
      (store.forTenant as ReturnType<typeof vi.fn>).mockReturnValue(
        tenantStore,
      );

      const dm = createNativeDurableMachine(createOptions(pool, store));
      const tenantDm = dm.forTenant("tenant-1");

      expect(store.forTenant).toHaveBeenCalledWith("tenant-1");
      // The returned object should have the same interface
      expect(typeof tenantDm.start).toBe("function");
      expect(typeof tenantDm.get).toBe("function");
      expect(typeof tenantDm.list).toBe("function");
      expect(typeof tenantDm.registerDefinition).toBe("function");
      expect(typeof tenantDm.consumeAndProcess).toBe("function");
      expect(typeof tenantDm.forTenant).toBe("function");
    });
  });
});
