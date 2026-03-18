import { describe, it, expect, vi } from "vitest";
import { createActor } from "xstate";
import { createRegistrationDefinition } from "../../../src/cmi5/create-definition.js";
import {
  createMachineFromDefinition, createImplementationRegistry, validateDefinition,
} from "@durable-machines/machine";
import type { CourseStructure } from "../../../src/cmi5/types.js";

// Deterministic builtins for testing
const testBuiltins: Record<string, (...args: unknown[]) => unknown> = {
  uuid: () => "test-uuid",
  now: () => "2025-01-01T00:00:00Z",
};

const emptyRegistry = createImplementationRegistry({ id: "empty" });

// Test course:
//   Block "block-1" containing:
//     AU "au-1" (Passed, masteryScore: 80)
//     AU "au-2" (Completed)
//   AU "au-3" at root level (NotApplicable)
function testCourseStructure(): CourseStructure {
  return {
    id: "test-course",
    title: "Integration Test Course",
    aus: {
      "au-1": {
        id: "au-1", title: "Graded AU", moveOn: "Passed",
        masteryScore: 80, launchUrl: "http://example.com/au1", launchMethod: "OwnWindow",
      },
      "au-2": {
        id: "au-2", title: "Completion AU", moveOn: "Completed",
        launchUrl: "http://example.com/au2", launchMethod: "OwnWindow",
      },
      "au-3": {
        id: "au-3", title: "Auto AU", moveOn: "NotApplicable",
        launchUrl: "http://example.com/au3", launchMethod: "OwnWindow",
      },
    },
    blocks: {
      "block-1": {
        id: "block-1", title: "Main Block",
        children: [
          { type: "au", id: "au-1" },
          { type: "au", id: "au-2" },
        ],
      },
    },
    rootChildren: [
      { type: "block", id: "block-1" },
      { type: "au", id: "au-3" },
    ],
  };
}

function createTestMachine() {
  const cs = testCourseStructure();
  const def = createRegistrationDefinition(cs);
  return createMachineFromDefinition(def, emptyRegistry, { builtins: testBuiltins });
}

describe("CMI5 registration machine integration", () => {
  it("full lifecycle: AU satisfaction, block/course cascade, sessions", () => {
    const machine = createTestMachine();
    const emitted: Array<Record<string, unknown>> = [];
    const actor = createActor(machine);
    actor.on("*", (event) => { emitted.push(event as any); });
    actor.start();

    // ─── Step 1: Initial state ───────────────────────────────────────
    // au-3 (NotApplicable) auto-satisfies via always transition
    let snap = actor.getSnapshot();
    const ctx = () => snap.context as any;

    expect(ctx().aus["au-3"].method).toBe("notApplicable");
    expect(ctx().aus["au-3"].satisfiedAt).toBe("2025-01-01T00:00:00Z");
    // au-1 and au-2 still unsatisfied
    expect(ctx().aus["au-1"].satisfiedAt).toBeNull();
    expect(ctx().aus["au-2"].satisfiedAt).toBeNull();

    // ─── Step 2: VERB_RECEIVED with insufficient score ───────────────
    actor.send({
      type: "VERB_RECEIVED",
      auId: "au-1",
      verbId: "http://adlnet.gov/expapi/verbs/passed",
      score: 50,
    });
    snap = actor.getSnapshot();
    // Guard rejects (50 < 80), au-1 unchanged — but updateAU should fire
    // since hasPassed changed (score too low → hasPassed stays false via mastery check)
    // Actually: passed verb + score 50 < masteryScore 80 → hasPassed stays false
    // hasFailed stays false. No flags changed → verbUpdatesAU guard also fails.
    expect(ctx().aus["au-1"].satisfiedAt).toBeNull();
    expect(ctx().aus["au-1"].hasPassed).toBe(false);

    // ─── Step 3: VERB_RECEIVED with sufficient score ─────────────────
    actor.send({
      type: "VERB_RECEIVED",
      auId: "au-1",
      verbId: "http://adlnet.gov/expapi/verbs/passed",
      score: 90,
    });
    snap = actor.getSnapshot();
    expect(ctx().aus["au-1"].hasPassed).toBe(true);
    expect(ctx().aus["au-1"].method).toBe("passed");
    expect(ctx().aus["au-1"].satisfiedAt).toBe("2025-01-01T00:00:00Z");
    expect(ctx().aus["au-1"].score).toEqual({ scaled: 90 });
    // Block not yet done (au-2 still unsatisfied)
    expect(ctx().satisfiedBlocks).toEqual([]);
    expect(ctx().courseSatisfied).toBe(false);

    // ─── Step 4: VERB_RECEIVED completes au-2 → block + course cascade ──
    actor.send({
      type: "VERB_RECEIVED",
      auId: "au-2",
      verbId: "http://adlnet.gov/expapi/verbs/completed",
    });
    snap = actor.getSnapshot();
    expect(ctx().aus["au-2"].hasCompleted).toBe(true);
    expect(ctx().aus["au-2"].method).toBe("completed");
    expect(ctx().aus["au-2"].satisfiedAt).toBe("2025-01-01T00:00:00Z");
    // Block cascade
    expect(ctx().satisfiedBlocks).toContain("block-1");
    // Course cascade (all root children done: block-1 + au-3)
    expect(ctx().courseSatisfied).toBe(true);
    expect(ctx().courseSatisfiedAt).toBe("2025-01-01T00:00:00Z");

    // ─── Step 5: Session lifecycle ───────────────────────────────────
    actor.send({
      type: "LAUNCH_SESSION",
      sessionId: "s1",
      auId: "au-1",
      launchMode: "Normal",
      timestamp: "2025-01-01T01:00:00Z",
      fetchToken: "tok-1",
    });
    snap = actor.getSnapshot();
    expect(ctx().sessions["s1"]).toBeDefined();
    expect(ctx().sessions["s1"].state).toBe("launched");
    expect(ctx().sessions["s1"].auId).toBe("au-1");

    // INITIALIZED → sessions region transitions idle → active
    actor.send({
      type: "INITIALIZED",
      sessionId: "s1",
      timestamp: "2025-01-01T01:05:00Z",
    });
    snap = actor.getSnapshot();
    expect(ctx().sessions["s1"].state).toBe("active");
    expect(ctx().sessions["s1"].initializedAt).toBe("2025-01-01T01:05:00Z");

    // ANSWERED → self-transition on active (resets timer)
    actor.send({
      type: "ANSWERED",
      sessionId: "s1",
      timestamp: "2025-01-01T02:00:00Z",
      score: 0.95,
      success: true,
    });
    snap = actor.getSnapshot();
    // Session still active
    expect(ctx().sessions["s1"].state).toBe("active");

    // TERMINATED → sessions back to idle
    actor.send({
      type: "TERMINATED",
      sessionId: "s1",
      timestamp: "2025-01-01T03:00:00Z",
    });
    snap = actor.getSnapshot();
    expect(ctx().sessions["s1"].state).toBe("terminated");
    expect(ctx().sessions["s1"].terminatedAt).toBe("2025-01-01T03:00:00Z");

    // ─── Verify emitted events ───────────────────────────────────────
    const emitTypes = emitted.map(e => e.type);
    expect(emitTypes).toContain("EMIT_SATISFIED_AU");
    expect(emitTypes).toContain("EMIT_AU_PASSED");
    expect(emitTypes).toContain("EMIT_SATISFIED_BLOCK");
    expect(emitTypes).toContain("EMIT_SATISFIED_COURSE");
    expect(emitTypes).toContain("SESSION_LAUNCHED");
    expect(emitTypes).toContain("SESSION_INITIALIZED");
    expect(emitTypes).toContain("SESSION_TERMINATED");

    actor.stop();
  });

  it("waive AU transitions to satisfied and cascades", () => {
    const machine = createTestMachine();
    const actor = createActor(machine);
    actor.start();

    // Satisfy au-1 via VERB_RECEIVED
    actor.send({
      type: "VERB_RECEIVED",
      auId: "au-1",
      verbId: "http://adlnet.gov/expapi/verbs/passed",
      score: 90,
    });

    // Waive au-2
    actor.send({ type: "WAIVED", auId: "au-2", timestamp: "2025-01-01T00:00:00Z" });

    const snap = actor.getSnapshot();
    const ctx = snap.context as any;
    expect(ctx.aus["au-2"].hasWaived).toBe(true);
    expect(ctx.aus["au-2"].method).toBe("waived");
    expect(ctx.satisfiedBlocks).toContain("block-1");
    expect(ctx.courseSatisfied).toBe(true);

    actor.stop();
  });

  it("definition is fully JSON-serializable", () => {
    const def = createRegistrationDefinition(testCourseStructure());
    const json = JSON.stringify(def);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(def);
  });

  it("assessment AU: verb → pending_signoff → signoff_approved → satisfied", () => {
    const cs = testCourseStructure();
    cs.aus["au-1"].purpose = "assessment";
    const def = createRegistrationDefinition(cs);
    const machine = createMachineFromDefinition(def, emptyRegistry, { builtins: testBuiltins });
    const emitted: Array<Record<string, unknown>> = [];
    const actor = createActor(machine);
    actor.on("*", (event) => { emitted.push(event as any); });
    actor.start();

    // Send passing verb → should move to pending_signoff
    actor.send({
      type: "VERB_RECEIVED",
      auId: "au-1",
      verbId: "http://adlnet.gov/expapi/verbs/passed",
      score: 90,
    });
    let snap = actor.getSnapshot();
    let ctx = snap.context as any;
    expect(ctx.aus["au-1"].hasPassed).toBe(true);
    expect(ctx.aus["au-1"].method).toBe("passed");
    expect(ctx.aus["au-1"].satisfiedAt).toBeNull(); // NOT set yet
    expect(emitted.some((e) => e.type === "ASSESSMENT_PENDING_SIGNOFF")).toBe(true);

    // Approve signoff → should move to satisfied
    actor.send({
      type: "SIGNOFF_APPROVED",
      auId: "au-1",
      timestamp: "2025-01-02T00:00:00Z",
    });
    snap = actor.getSnapshot();
    ctx = snap.context as any;
    expect(ctx.aus["au-1"].satisfiedAt).toBe("2025-01-02T00:00:00Z");

    // Complete au-2 → block + course cascade
    actor.send({
      type: "VERB_RECEIVED",
      auId: "au-2",
      verbId: "http://adlnet.gov/expapi/verbs/completed",
    });
    snap = actor.getSnapshot();
    ctx = snap.context as any;
    expect(ctx.satisfiedBlocks).toContain("block-1");
    expect(ctx.courseSatisfied).toBe(true);

    actor.stop();
  });

  it("assessment AU: verb → pending_signoff → signoff_returned → back to unsatisfied", () => {
    const cs = testCourseStructure();
    cs.aus["au-1"].purpose = "assessment";
    const def = createRegistrationDefinition(cs);
    const machine = createMachineFromDefinition(def, emptyRegistry, { builtins: testBuiltins });
    const emitted: Array<Record<string, unknown>> = [];
    const actor = createActor(machine);
    actor.on("*", (event) => { emitted.push(event as any); });
    actor.start();

    // Pass → pending_signoff
    actor.send({
      type: "VERB_RECEIVED",
      auId: "au-1",
      verbId: "http://adlnet.gov/expapi/verbs/passed",
      score: 90,
    });
    let snap = actor.getSnapshot();
    expect((snap.context as any).aus["au-1"].hasPassed).toBe(true);

    // Return → back to unsatisfied with flags reset
    actor.send({
      type: "SIGNOFF_RETURNED",
      auId: "au-1",
      supervisorId: "supervisor-1",
      reason: "Needs improvement",
      timestamp: "2025-01-02T00:00:00Z",
    });
    snap = actor.getSnapshot();
    const ctx = snap.context as any;
    expect(ctx.aus["au-1"].hasPassed).toBe(false);
    expect(ctx.aus["au-1"].hasCompleted).toBe(false);
    expect(ctx.aus["au-1"].hasFailed).toBe(false);
    expect(ctx.aus["au-1"].method).toBeNull();
    expect(ctx.aus["au-1"].score).toBeNull();
    expect(emitted.some((e) => e.type === "ASSESSMENT_RETURNED")).toBe(true);

    actor.stop();
  });

  it("session launch abandons existing open sessions", () => {
    const machine = createTestMachine();
    const emitted: Array<Record<string, unknown>> = [];
    const actor = createActor(machine);
    actor.on("*", (event) => { emitted.push(event as any); });
    actor.start();

    // Launch s1 + initialize
    actor.send({ type: "LAUNCH_SESSION", sessionId: "s1", auId: "au-1", launchMode: "Normal", timestamp: "2025-01-01T00:00:00Z", fetchToken: "tok-1" });
    actor.send({ type: "INITIALIZED", sessionId: "s1", timestamp: "2025-01-01T00:01:00Z" });

    let snap = actor.getSnapshot();
    expect((snap.context as any).sessions["s1"].state).toBe("active");

    // Launch s2 → should abandon s1
    actor.send({ type: "LAUNCH_SESSION", sessionId: "s2", auId: "au-2", launchMode: "Normal", timestamp: "2025-01-01T01:00:00Z", fetchToken: "tok-2" });
    snap = actor.getSnapshot();
    const ctx = snap.context as any;
    expect(ctx.sessions["s1"].state).toBe("abandoned");
    expect(ctx.sessions["s2"].state).toBe("launched");
    expect(emitted.some((e) => e.type === "SESSIONS_ABANDONED")).toBe(true);

    actor.stop();
  });

  it("session timeout emits EMIT_ABANDONED with duration", () => {
    vi.useFakeTimers({ now: new Date("2025-01-01T00:00:00Z") });

    // now() returns advancing clock time so duration can be computed
    let nowCallCount = 0;
    const builtins: Record<string, (...args: unknown[]) => unknown> = {
      uuid: () => "test-uuid",
      now: () => {
        nowCallCount++;
        // First call: during satisfyNotApplicableAU at machine start
        // Second call: framework enriches the `after` event with timestamp
        if (nowCallCount <= 1) return "2025-01-01T00:00:00Z";
        return "2025-01-01T08:00:00Z";
      },
      iso8601Duration: (start: unknown, end: unknown) => {
        const ms = new Date(end as string).getTime() - new Date(start as string).getTime();
        return `PT${Math.max(0, ms / 1000)}S`;
      },
    };
    const cs = testCourseStructure();
    const def = createRegistrationDefinition(cs);
    const machine = createMachineFromDefinition(def, emptyRegistry, { builtins });
    const emitted: Array<Record<string, unknown>> = [];
    const actor = createActor(machine);
    actor.on("*", (event) => { emitted.push(event as any); });
    actor.start();

    // Launch + initialize a session
    actor.send({ type: "LAUNCH_SESSION", sessionId: "s1", auId: "au-1", launchMode: "Normal", timestamp: "2025-01-01T00:00:00Z", fetchToken: "tok-1" });
    actor.send({ type: "INITIALIZED", sessionId: "s1", timestamp: "2025-01-01T00:01:00Z" });

    // Advance fake timers to trigger the `after` delayed transition (8 hours)
    vi.advanceTimersByTime(28_800_000);

    const snap = actor.getSnapshot();
    expect((snap.context as any).sessions["s1"].state).toBe("abandoned");
    expect((snap.context as any).activeSessionId).toBeNull();

    const abandonedEffect = emitted.find((e) => e.type === "EMIT_ABANDONED");
    expect(abandonedEffect).toBeDefined();
    expect(abandonedEffect!.duration).toBe("PT28800S"); // 8 hours
    expect(abandonedEffect!.auId).toBe("au-1");

    actor.stop();
    vi.useRealTimers();
  });

  it("definition passes validation", () => {
    const def = createRegistrationDefinition(testCourseStructure());
    const result = validateDefinition(def, emptyRegistry);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
