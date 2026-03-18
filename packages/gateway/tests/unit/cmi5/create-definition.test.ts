import { describe, it, expect } from "vitest";
import { createRegistrationDefinition } from "../../../src/cmi5/create-definition.js";
import { validateDefinition, createImplementationRegistry } from "@durable-xstate/durable-machine";
import type { CourseStructure } from "../../../src/cmi5/types.js";

const emptyRegistry = createImplementationRegistry({ id: "empty" });

function simpleCourse(): CourseStructure {
  return {
    id: "course-1",
    title: "Test Course",
    aus: {
      "au-1": { id: "au-1", title: "AU One", moveOn: "Passed", masteryScore: 80, launchUrl: "http://example.com/1", launchMethod: "OwnWindow" },
      "au-2": { id: "au-2", title: "AU Two", moveOn: "Completed", launchUrl: "http://example.com/2", launchMethod: "OwnWindow" },
    },
    blocks: {
      "block-1": { id: "block-1", title: "Block One", children: [
        { type: "au", id: "au-1" },
        { type: "au", id: "au-2" },
      ] },
    },
    rootChildren: [
      { type: "block", id: "block-1" },
    ],
  };
}

function courseWithRootAU(): CourseStructure {
  return {
    id: "course-2",
    title: "Mixed Course",
    aus: {
      "au-1": { id: "au-1", title: "AU One", moveOn: "Passed", masteryScore: 80, launchUrl: "http://example.com/1", launchMethod: "OwnWindow" },
      "au-2": { id: "au-2", title: "AU Two", moveOn: "Completed", launchUrl: "http://example.com/2", launchMethod: "OwnWindow" },
      "au-3": { id: "au-3", title: "AU Three", moveOn: "NotApplicable", launchUrl: "http://example.com/3", launchMethod: "OwnWindow" },
    },
    blocks: {
      "block-1": { id: "block-1", title: "Block One", children: [
        { type: "au", id: "au-1" },
        { type: "au", id: "au-2" },
      ] },
    },
    rootChildren: [
      { type: "block", id: "block-1" },
      { type: "au", id: "au-3" },
    ],
  };
}

describe("createRegistrationDefinition", () => {
  it("generates correct context shape", () => {
    const def = createRegistrationDefinition(simpleCourse());
    const ctx = def.context as any;
    expect(ctx.registrationId).toBeNull();
    expect(ctx.actor).toBeNull();
    expect(ctx.metadata.courseId).toBe("course-1");
    expect(ctx.metadata.courseTitle).toBe("Test Course");
    expect(ctx.metadata.auTitles).toEqual({ "au-1": "AU One", "au-2": "AU Two" });
    expect(ctx.metadata.blockTitles).toEqual({ "block-1": "Block One" });
    expect(Object.keys(ctx.aus)).toEqual(["au-1", "au-2"]);
    expect(ctx.aus["au-1"]).toEqual({
      hasCompleted: false, hasPassed: false, hasFailed: false, hasWaived: false,
      method: null, satisfiedAt: null, score: null,
    });
    expect(ctx.sessions).toEqual({});
    expect(ctx.satisfiedBlocks).toEqual([]);
    expect(ctx.courseSatisfied).toBe(false);
  });

  it("generates parallel tracking region with AU states", () => {
    const def = createRegistrationDefinition(simpleCourse());
    const active = def.states.active;
    expect(active.type).toBe("parallel");
    const tracking = active.states!.tracking;
    expect(tracking.type).toBe("parallel");
    // block_0 contains au_0 and au_1
    const block0 = tracking.states!.block_0;
    expect(block0.type).toBe("parallel");
    expect(block0.states!.au_0).toBeDefined();
    expect(block0.states!.au_1).toBeDefined();
  });

  it("generates correct AU state for Passed moveOn", () => {
    const def = createRegistrationDefinition(simpleCourse());
    const au0 = def.states.active.states!.tracking.states!.block_0.states!.au_0;
    expect(au0.initial).toBe("unsatisfied");
    expect(au0.states!.unsatisfied.durable).toBe(true);
    expect(au0.states!.satisfied.type).toBe("final");
    // VERB_RECEIVED transitions
    const verbTransitions = au0.states!.unsatisfied.on!.VERB_RECEIVED;
    expect(Array.isArray(verbTransitions)).toBe(true);
    const transitions = verbTransitions as any[];
    expect(transitions[0].target).toBe("satisfied");
    expect(transitions[0].guard.type).toBe("verbSatisfiesAU");
    expect(transitions[0].guard.params.auId).toBe("au-1");
    expect(transitions[0].guard.params.moveOn).toBe("Passed");
    expect(transitions[0].guard.params.masteryScore).toBe(80);
    // WAIVED transition
    const waivedTrans = au0.states!.unsatisfied.on!.WAIVED as any;
    expect(waivedTrans.target).toBe("satisfied");
    expect(waivedTrans.guard.type).toBe("waiveTargetsAU");
  });

  it("generates transient always transition for NotApplicable AU", () => {
    const def = createRegistrationDefinition(courseWithRootAU());
    const au2 = def.states.active.states!.tracking.states!.au_2;
    expect(au2.initial).toBe("unsatisfied");
    const unsatisfied = au2.states!.unsatisfied;
    expect(unsatisfied.durable).toBeUndefined();
    expect(unsatisfied.always).toBeDefined();
    const always = unsatisfied.always as any;
    expect(always.target).toBe("satisfied");
    expect(always.actions.type).toBe("satisfyNotApplicableAU");
    expect(always.actions.params.auId).toBe("au-3");
  });

  it("generates block done event handler on tracking", () => {
    const def = createRegistrationDefinition(simpleCourse());
    const tracking = def.states.active.states!.tracking;
    const expectedEvent = "xstate.done.state.registration.active.tracking.block_0";
    expect(tracking.on![expectedEvent]).toBeDefined();
    const handler = tracking.on![expectedEvent] as any;
    expect(handler.actions.type).toBe("satisfyBlock");
    expect(handler.actions.params.blockId).toBe("block-1");
  });

  it("generates course-level done event handler on active", () => {
    const def = createRegistrationDefinition(simpleCourse());
    const expectedEvent = "xstate.done.state.registration.active.tracking";
    const handler = def.states.active.on![expectedEvent] as any;
    expect(handler.actions).toBe("satisfyCourse");
  });

  it("generates sessions region with idle/active states", () => {
    const def = createRegistrationDefinition(simpleCourse());
    const sessions = def.states.active.states!.sessions;
    expect(sessions.initial).toBe("idle");
    expect(sessions.states!.idle.durable).toBe(true);
    expect(sessions.states!.active.durable).toBe(true);
    expect(sessions.states!.active.after!["28800000"]).toBeDefined();
  });

  it("generates 3-state topology for assessment AU", () => {
    const cs = simpleCourse();
    cs.aus["au-1"].purpose = "assessment";
    const def = createRegistrationDefinition(cs);
    const au0 = def.states.active.states!.tracking.states!.block_0.states!.au_0;
    expect(au0.initial).toBe("unsatisfied");
    expect(au0.states!.unsatisfied.durable).toBe(true);
    expect(au0.states!.pending_signoff).toBeDefined();
    expect(au0.states!.pending_signoff.durable).toBe(true);
    expect(au0.states!.satisfied.type).toBe("final");
    // VERB_RECEIVED on unsatisfied targets pending_signoff
    const verbTransitions = au0.states!.unsatisfied.on!.VERB_RECEIVED as any[];
    expect(verbTransitions[0].target).toBe("pending_signoff");
    expect(verbTransitions[0].actions.type).toBe("requestSignoff");
    // SIGNOFF events on pending_signoff
    const signoffApproved = au0.states!.pending_signoff.on!.SIGNOFF_APPROVED as any;
    expect(signoffApproved.target).toBe("satisfied");
    expect(signoffApproved.guard.type).toBe("signoffTargetsAU");
    expect(signoffApproved.actions.type).toBe("approveAssessment");
    const signoffReturned = au0.states!.pending_signoff.on!.SIGNOFF_RETURNED as any;
    expect(signoffReturned.target).toBe("unsatisfied");
    expect(signoffReturned.actions.type).toBe("returnAssessment");
  });

  it("includes all named guards", () => {
    const def = createRegistrationDefinition(simpleCourse());
    expect(def.guards).toBeDefined();
    expect(def.guards!.verbSatisfiesAU).toBeDefined();
    expect(def.guards!.verbUpdatesAU).toBeDefined();
    expect(def.guards!.waiveTargetsAU).toBeDefined();
    expect(def.guards!.signoffTargetsAU).toBeDefined();
  });

  it("includes all named actions", () => {
    const def = createRegistrationDefinition(simpleCourse());
    expect(def.actions).toBeDefined();
    const actionNames = Object.keys(def.actions!);
    expect(actionNames).toContain("satisfyAU");
    expect(actionNames).toContain("updateAU");
    expect(actionNames).toContain("waiveAU");
    expect(actionNames).toContain("satisfyNotApplicableAU");
    expect(actionNames).toContain("satisfyBlock");
    expect(actionNames).toContain("satisfyCourse");
    expect(actionNames).toContain("handleSessionLaunch");
    expect(actionNames).toContain("handleFetchTokenRetrieved");
    expect(actionNames).toContain("handleInitialized");
    expect(actionNames).toContain("handleTerminated");
    expect(actionNames).toContain("handleSessionTimeout");
    expect(actionNames).toContain("handleAnswered");
    expect(actionNames).toContain("requestSignoff");
    expect(actionNames).toContain("approveAssessment");
    expect(actionNames).toContain("returnAssessment");
  });

  it("passes validateDefinition", () => {
    const def = createRegistrationDefinition(courseWithRootAU());
    const result = validateDefinition(def, emptyRegistry);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("is fully JSON-serializable (roundtrips identically)", () => {
    const def = createRegistrationDefinition(courseWithRootAU());
    const roundTripped = JSON.parse(JSON.stringify(def));
    expect(roundTripped).toEqual(def);
  });
});
