import { describe, it, expect } from "vitest";
import { setup, fromPromise, createMachine } from "xstate";
import { quiescent } from "../../src/quiescent.js";
import { prompt } from "../../src/prompt.js";
import { validateMachineForDurability } from "../../src/validate.js";
import { DurableMachineValidationError } from "../../src/types.js";

describe("validateMachineForDurability()", () => {
  describe("valid machines", () => {
    it("passes for a machine with quiescent and final states", () => {
      const machine = createMachine({
        id: "simple",
        initial: "waiting",
        states: {
          waiting: {
            ...quiescent(),
            on: { GO: "done" },
          },
          done: { type: "final" },
        },
      });

      expect(() => validateMachineForDurability(machine)).not.toThrow();
    });

    it("passes for a machine with invoke states", () => {
      const machine = setup({
        actors: {
          doWork: fromPromise(async () => "result"),
        },
      }).createMachine({
        id: "invoking",
        initial: "working",
        states: {
          working: {
            invoke: {
              src: "doWork",
              onDone: "done",
            },
          },
          done: { type: "final" },
        },
      });

      expect(() => validateMachineForDurability(machine)).not.toThrow();
    });

    it("passes for a machine with always (transient) states", () => {
      const machine = setup({
        guards: {
          isReady: () => true,
        },
      }).createMachine({
        id: "transient",
        initial: "checking",
        states: {
          checking: {
            always: [
              { guard: "isReady", target: "ready" },
              { target: "notReady" },
            ],
          },
          ready: {
            ...quiescent(),
            on: { DONE: "finished" },
          },
          notReady: {
            ...quiescent(),
            on: { RETRY: "checking" },
          },
          finished: { type: "final" },
        },
      });

      expect(() => validateMachineForDurability(machine)).not.toThrow();
    });

    it("passes for a machine with prompt (which implies quiescent) + matching on handlers", () => {
      const machine = createMachine({
        id: "prompted",
        initial: "waiting",
        states: {
          waiting: {
            ...prompt({
              type: "choice",
              text: "Approve?",
              options: [
                { label: "Yes", event: "APPROVE" },
                { label: "No", event: "REJECT" },
              ],
            }),
            on: {
              APPROVE: "approved",
              REJECT: "rejected",
            },
          },
          approved: { type: "final" },
          rejected: { type: "final" },
        },
      });

      // prompt() includes quiescent: true in its meta, so this should pass
      expect(() => validateMachineForDurability(machine)).not.toThrow();
    });

    it("passes when both quiescent() and prompt() are spread (prompt wins, includes quiescent)", () => {
      const machine = createMachine({
        id: "both",
        initial: "waiting",
        states: {
          waiting: {
            ...quiescent(),
            ...prompt({
              type: "confirm",
              text: "Continue?",
              confirmEvent: "YES",
              cancelEvent: "NO",
            }),
            on: { YES: "done", NO: "cancelled" },
          },
          done: { type: "final" },
          cancelled: { type: "final" },
        },
      });

      expect(() => validateMachineForDurability(machine)).not.toThrow();
    });

    it("passes for a mixed machine with quiescent, invoke, and always states", () => {
      const machine = setup({
        actors: {
          process: fromPromise(async () => "done"),
        },
        guards: {
          isValid: () => true,
        },
      }).createMachine({
        id: "mixed",
        initial: "pending",
        states: {
          pending: {
            ...quiescent(),
            on: { START: "validating" },
          },
          validating: {
            always: [
              { guard: "isValid", target: "processing" },
              { target: "invalid" },
            ],
          },
          processing: {
            invoke: {
              src: "process",
              onDone: "done",
              onError: "failed",
            },
          },
          done: { type: "final" },
          failed: { type: "final" },
          invalid: { type: "final" },
        },
      });

      expect(() => validateMachineForDurability(machine)).not.toThrow();
    });
  });

  describe("invalid machines", () => {
    it("rejects a machine with no explicit id", () => {
      // XState auto-generates "(machine)" as id when none is provided
      const machine = createMachine({
        initial: "waiting",
        states: {
          waiting: {
            ...quiescent(),
            on: { GO: "done" },
          },
          done: { type: "final" },
        },
      });

      expect(() => validateMachineForDurability(machine)).toThrow(
        DurableMachineValidationError,
      );
      try {
        validateMachineForDurability(machine);
      } catch (e) {
        const err = e as DurableMachineValidationError;
        expect(err.errors.some((e) => e.includes("explicit id"))).toBe(true);
      }
    });

    it("rejects a state with no invoke, no always, and no quiescent marker", () => {
      const machine = createMachine({
        id: "bad",
        initial: "stuck",
        states: {
          stuck: {
            on: { GO: "done" },
          },
          done: { type: "final" },
        },
      });

      expect(() => validateMachineForDurability(machine)).toThrow(
        DurableMachineValidationError,
      );
      try {
        validateMachineForDurability(machine);
      } catch (e) {
        const err = e as DurableMachineValidationError;
        expect(err.errors).toHaveLength(1);
        expect(err.errors[0]).toContain("stuck");
        expect(err.errors[0]).toContain("not quiescent");
      }
    });

    it("rejects a state with both invoke and quiescent", () => {
      const machine = setup({
        actors: {
          doWork: fromPromise(async () => "result"),
        },
      }).createMachine({
        id: "conflicting",
        initial: "broken",
        states: {
          broken: {
            ...quiescent(),
            invoke: {
              src: "doWork",
              onDone: "done",
            },
          },
          done: { type: "final" },
        },
      });

      expect(() => validateMachineForDurability(machine)).toThrow(
        DurableMachineValidationError,
      );
      try {
        validateMachineForDurability(machine);
      } catch (e) {
        const err = e as DurableMachineValidationError;
        expect(err.errors.some((e) => e.includes("both invoke and quiescent"))).toBe(true);
      }
    });

    it("rejects a prompt on an invoke state (prompt implies quiescent, conflicts with invoke)", () => {
      const machine = setup({
        actors: {
          doWork: fromPromise(async () => "result"),
        },
      }).createMachine({
        id: "badPrompt",
        initial: "working",
        states: {
          working: {
            ...prompt({
              type: "choice",
              text: "Choose",
              options: [{ label: "A", event: "A" }],
            }),
            invoke: {
              src: "doWork",
              onDone: "done",
            },
          },
          done: { type: "final" },
        },
      });

      // prompt() includes quiescent: true, so this triggers "both invoke and quiescent"
      expect(() => validateMachineForDurability(machine)).toThrow(
        DurableMachineValidationError,
      );
      try {
        validateMachineForDurability(machine);
      } catch (e) {
        const err = e as DurableMachineValidationError;
        expect(err.errors.some((e) => e.includes("both invoke and quiescent"))).toBe(true);
      }
    });

    it("rejects a prompt whose events don't match on handlers", () => {
      const machine = createMachine({
        id: "mismatch",
        initial: "waiting",
        states: {
          waiting: {
            ...quiescent(),
            ...prompt({
              type: "choice",
              text: "Choose",
              options: [
                { label: "Yes", event: "APPROVE" },
                { label: "No", event: "REJECT" },
              ],
            }),
            on: {
              APPROVE: "approved",
              // REJECT handler is missing!
            },
          },
          approved: { type: "final" },
        },
      });

      expect(() => validateMachineForDurability(machine)).toThrow(
        DurableMachineValidationError,
      );
      try {
        validateMachineForDurability(machine);
      } catch (e) {
        const err = e as DurableMachineValidationError;
        expect(err.errors.some((e) => e.includes("REJECT") && e.includes("no matching"))).toBe(true);
      }
    });

    it("collects multiple errors in a single throw", () => {
      const machine = createMachine({
        id: "multi-error",
        initial: "a",
        states: {
          a: {
            // No quiescent, no invoke, no always
            on: { GO: "b" },
          },
          b: {
            // Also missing classification
            on: { NEXT: "done" },
          },
          done: { type: "final" },
        },
      });

      try {
        validateMachineForDurability(machine);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as DurableMachineValidationError;
        expect(err.errors.length).toBeGreaterThanOrEqual(2);
        expect(err.errors.some((e) => e.includes('"a"'))).toBe(true);
        expect(err.errors.some((e) => e.includes('"b"'))).toBe(true);
      }
    });
  });
});
