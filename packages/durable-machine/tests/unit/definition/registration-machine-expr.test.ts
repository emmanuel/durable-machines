import { describe, it, expect } from "vitest";
import { initialTransition, transition } from "xstate";
import { createMachineFromDefinition } from "../../../src/definition/create-machine.js";
import { createImplementationRegistry } from "../../../src/definition/registry.js";
import type { MachineDefinition } from "../../../src/definition/types.js";
import { createBuiltinRegistry } from "@durable-machines/expr";

describe("registration machine via expr definitions", () => {
  const testBuiltins = createBuiltinRegistry({
    uuid: () => "test-uuid",
    now: () => 1718452800000,
  });

  const emptyRegistry = createImplementationRegistry({ id: "test" });

  it("verbSatisfiesAU guard + satisfyAU action — full transition", () => {
    const def: MachineDefinition = {
      id: "au-lifecycle",
      initial: "unsatisfied",
      context: {
        aus: {
          "au-1": { hasCompleted: false, hasPassed: false, hasFailed: false, method: null, satisfiedAt: null, score: null },
        },
        lastSatisfyingSessionId: null,
      },
      guards: {
        verbSatisfiesAU: {
          let: [
            {
              current: { select: ["context", "aus", { param: "auId" }] },
              score: { select: ["event", "score"] },
              nextHasCompleted: { or: [
                { select: ["current", "hasCompleted"] },
                { eq: [{ param: "verbId" }, "http://adlnet.gov/expapi/verbs/completed"] },
              ]},
              nextHasPassed: { or: [
                { select: ["current", "hasPassed"] },
                { and: [
                  { eq: [{ param: "verbId" }, "http://adlnet.gov/expapi/verbs/passed"] },
                  { if: [{ isNull: { ref: "score" } }, true, { gte: [{ ref: "score" }, { param: "masteryScore" }] }] },
                ]},
              ]},
            },
            { and: [
              { eq: [{ select: ["event", "auId"] }, { param: "auId" }] },
              { cond: [
                [{ eq: [{ param: "moveOn" }, "Completed"] }, { ref: "nextHasCompleted" }],
                [{ eq: [{ param: "moveOn" }, "Passed"] }, { ref: "nextHasPassed" }],
                [true, false],
              ]},
            ]},
          ],
        },
      },
      actions: {
        satisfyAU: {
          type: "enqueueActions",
          let: {
            sessionId: { coalesce: [{ select: ["event", "sessionId"] }, { fn: ["uuid"] }] },
            timestamp: { coalesce: [{ select: ["event", "timestamp"] }, { fn: ["now"] }] },
          },
          actions: [
            {
              type: "assign",
              transforms: [
                { path: ["aus", { param: "auId" }, "hasPassed"], set: true },
                { path: ["aus", { param: "auId" }, "method"], set: "passed" },
                { path: ["aus", { param: "auId" }, "satisfiedAt"], set: { ref: "timestamp" } },
                { path: ["lastSatisfyingSessionId"], set: { ref: "sessionId" } },
              ],
            },
          ],
        },
      },
      states: {
        unsatisfied: {
          durable: true,
          on: {
            VERB_RECEIVED: {
              target: "satisfied",
              guard: {
                type: "verbSatisfiesAU",
                params: { auId: "au-1", moveOn: "Passed", masteryScore: 80, verbId: "http://adlnet.gov/expapi/verbs/passed" },
              },
              actions: {
                type: "satisfyAU",
                params: { auId: "au-1", moveOn: "Passed", masteryScore: 80, verbId: "http://adlnet.gov/expapi/verbs/passed" },
              },
            },
          },
        },
        satisfied: { type: "final" },
      },
    };

    const machine = createMachineFromDefinition(def, emptyRegistry, { builtins: testBuiltins });

    // Initial state
    let [state] = initialTransition(machine);
    expect(state.value).toBe("unsatisfied");

    // Send passing verb with score >= masteryScore → should transition
    [state] = transition(machine, state, {
      type: "VERB_RECEIVED",
      auId: "au-1",
      verbId: "http://adlnet.gov/expapi/verbs/passed",
      score: 90,
      sessionId: "session-abc",
      timestamp: 1718452800000,
    });

    expect(state.value).toBe("satisfied");
    const au1 = (state.context.aus as any)["au-1"];
    expect(au1.hasPassed).toBe(true);
    expect(au1.method).toBe("passed");
    expect(au1.satisfiedAt).toBe(1718452800000);
    expect(state.context.lastSatisfyingSessionId).toBe("session-abc");
  });

  it("guard rejects when score below masteryScore", () => {
    const def: MachineDefinition = {
      id: "au-lifecycle-reject",
      initial: "unsatisfied",
      context: {
        aus: {
          "au-1": { hasCompleted: false, hasPassed: false, hasFailed: false, method: null, satisfiedAt: null, score: null },
        },
        lastSatisfyingSessionId: null,
      },
      guards: {
        verbSatisfiesAU: {
          let: [
            {
              current: { select: ["context", "aus", { param: "auId" }] },
              score: { select: ["event", "score"] },
              nextHasPassed: { or: [
                { select: ["current", "hasPassed"] },
                { and: [
                  { eq: [{ param: "verbId" }, "http://adlnet.gov/expapi/verbs/passed"] },
                  { if: [{ isNull: { ref: "score" } }, true, { gte: [{ ref: "score" }, { param: "masteryScore" }] }] },
                ]},
              ]},
            },
            { and: [
              { eq: [{ select: ["event", "auId"] }, { param: "auId" }] },
              { ref: "nextHasPassed" },
            ]},
          ],
        },
      },
      actions: {
        satisfyAU: {
          type: "assign",
          transforms: [
            { path: ["aus", { param: "auId" }, "hasPassed"], set: true },
          ],
        },
      },
      states: {
        unsatisfied: {
          durable: true,
          on: {
            VERB_RECEIVED: {
              target: "satisfied",
              guard: {
                type: "verbSatisfiesAU",
                params: { auId: "au-1", masteryScore: 80, verbId: "http://adlnet.gov/expapi/verbs/passed" },
              },
              actions: {
                type: "satisfyAU",
                params: { auId: "au-1" },
              },
            },
          },
        },
        satisfied: { type: "final" },
      },
    };

    const machine = createMachineFromDefinition(def, emptyRegistry, { builtins: testBuiltins });
    let [state] = initialTransition(machine);

    // Score 50 < masteryScore 80 → guard rejects, stays unsatisfied
    [state] = transition(machine, state, {
      type: "VERB_RECEIVED",
      auId: "au-1",
      verbId: "http://adlnet.gov/expapi/verbs/passed",
      score: 50,
    });
    expect(state.value).toBe("unsatisfied");

    // Score 90 >= masteryScore 80 → guard accepts
    [state] = transition(machine, state, {
      type: "VERB_RECEIVED",
      auId: "au-1",
      verbId: "http://adlnet.gov/expapi/verbs/passed",
      score: 90,
    });
    expect(state.value).toBe("satisfied");
  });
});
