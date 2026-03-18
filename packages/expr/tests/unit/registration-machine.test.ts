import { describe, it, expect } from "vitest";
import { evaluate } from "../../src/evaluate.js";
import { evaluateActions } from "../../src/actions.js";
import { createScope } from "../../src/types.js";
import { defaultBuiltins, createBuiltinRegistry } from "../../src/builtins.js";

// ─── Context Factory ──────────────────────────────────────────────────────────

function makeRegistrationContext(overrides?: Record<string, unknown>) {
  return {
    registrationId: "reg-1",
    actor: { name: "Test User", mbox: "test@example.com" },
    metadata: {
      courseId: "course-1",
      courseTitle: "Test Course",
      auTitles: { "au-1": "Lesson 1", "au-2": "Lesson 2" },
      blockTitles: { "block-1": "Block 1" },
    },
    aus: {
      "au-1": { hasCompleted: false, hasPassed: false, hasFailed: false, method: null, satisfiedAt: null, score: null },
      "au-2": { hasCompleted: true, hasPassed: false, hasFailed: false, method: null, satisfiedAt: null, score: null },
    },
    sessions: {} as Record<string, unknown>,
    satisfiedBlocks: [] as string[],
    courseSatisfied: false,
    lastSatisfyingSessionId: null as string | null,
    ...overrides,
  };
}

// ─── Guard Fixtures ───────────────────────────────────────────────────────────

const verbSatisfiesAU = {
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
        [{ eq: [{ param: "moveOn" }, "CompletedAndPassed"] }, { and: [{ ref: "nextHasCompleted" }, { ref: "nextHasPassed" }] }],
        [{ eq: [{ param: "moveOn" }, "CompletedOrPassed"] }, { or: [{ ref: "nextHasCompleted" }, { ref: "nextHasPassed" }] }],
        [{ eq: [{ param: "moveOn" }, "NotApplicable"] }, true],
        [true, false],
      ]},
    ]},
  ],
};

const waiveTargetsAU = {
  and: [
    { eq: [{ select: ["event", "type"] }, "WAIVED"] },
    { eq: [{ select: ["event", "auId"] }, { param: "auId" }] },
  ],
};

const signoffTargetsAU = {
  and: [
    { in: [{ select: ["event", "type"] }, ["SIGNOFF_APPROVED", "SIGNOFF_RETURNED"]] },
    { eq: [{ select: ["event", "auId"] }, { param: "auId" }] },
  ],
};

// ─── Action Fixtures ──────────────────────────────────────────────────────────

const satisfyAU = {
  type: "enqueueActions" as const,
  let: {
    current: { select: ["context", "aus", { param: "auId" }] },
    score: { select: ["event", "score"] },
    sessionId: { coalesce: [{ select: ["event", "sessionId"] }, { fn: ["uuid"] }] },
    timestamp: { coalesce: [{ select: ["event", "timestamp"] }, { fn: ["now"] }] },
    auTitle: { coalesce: [
      { select: ["context", "metadata", "auTitles", { param: "auId" }] },
      { param: "auId" },
    ]},
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
    nextHasFailed: { or: [
      { select: ["current", "hasFailed"] },
      { eq: [{ param: "verbId" }, "http://adlnet.gov/expapi/verbs/failed"] },
    ]},
    method: { cond: [
      [{ eq: [{ param: "moveOn" }, "Completed"] }, "completed"],
      [{ eq: [{ param: "moveOn" }, "Passed"] }, "passed"],
      [{ eq: [{ param: "moveOn" }, "CompletedAndPassed"] }, "completedAndPassed"],
      [{ eq: [{ param: "moveOn" }, "CompletedOrPassed"] }, { if: [{ ref: "nextHasPassed" }, "passed", "completed"] }],
      [{ eq: [{ param: "moveOn" }, "NotApplicable"] }, "notApplicable"],
      [true, null],
    ]},
  },
  actions: [
    {
      type: "assign" as const,
      transforms: [
        { path: ["aus", { param: "auId" }, "hasCompleted"], set: { ref: "nextHasCompleted" } },
        { path: ["aus", { param: "auId" }, "hasPassed"], set: { ref: "nextHasPassed" } },
        { path: ["aus", { param: "auId" }, "hasFailed"], set: { ref: "nextHasFailed" } },
        { path: ["aus", { param: "auId" }, "method"], set: { ref: "method" } },
        { path: ["aus", { param: "auId" }, "satisfiedAt"], set: { ref: "timestamp" } },
        { path: ["lastSatisfyingSessionId"], set: { ref: "sessionId" } },
      ],
    },
    {
      guard: { not: { isNull: { ref: "score" } } },
      actions: [{
        type: "assign" as const,
        transforms: [
          { path: ["aus", { param: "auId" }, "score"], set: { object: { scaled: { ref: "score" } } } },
        ],
      }],
    },
    {
      guard: { and: [{ ref: "nextHasPassed" }, { not: { select: ["current", "hasPassed"] } }] },
      actions: [{
        type: "emit" as const,
        event: {
          type: "EMIT_AU_PASSED",
          registrationId: { select: ["context", "registrationId"] },
          actor: { select: ["context", "actor"] },
          auId: { param: "auId" },
          auTitle: { ref: "auTitle" },
          sessionId: { ref: "sessionId" },
          timestamp: { ref: "timestamp" },
          score: { ref: "score" },
        },
      }],
    },
    {
      type: "emit" as const,
      event: {
        type: "EMIT_SATISFIED_AU",
        registrationId: { select: ["context", "registrationId"] },
        actor: { select: ["context", "actor"] },
        auId: { param: "auId" },
        auTitle: { ref: "auTitle" },
        sessionId: { ref: "sessionId" },
        timestamp: { ref: "timestamp" },
      },
    },
  ],
};

const handleSessionLaunch = {
  type: "enqueueActions" as const,
  let: {
    sessionId: { select: ["event", "sessionId"] },
  },
  actions: [
    {
      type: "emit" as const,
      event: {
        type: "SESSIONS_ABANDONED",
        registrationId: { select: ["context", "registrationId"] },
        actor: { select: ["context", "actor"] },
        timestamp: { select: ["event", "timestamp"] },
        sessions: { select: ["context", "sessions", { where: { in: ["state", ["launched", "active"]] } }] },
      },
    },
    {
      type: "assign" as const,
      transforms: [
        {
          path: ["sessions", { where: { in: ["state", ["launched", "active"]] } }, "state"],
          set: "abandoned",
        },
        {
          path: ["sessions", { ref: "sessionId" }],
          set: { object: {
            state: "launched",
            auId: { select: ["event", "auId"] },
            launchMode: { select: ["event", "launchMode"] },
            launchedAt: { select: ["event", "timestamp"] },
            fetchToken: { select: ["event", "fetchToken"] },
          }},
        },
      ],
    },
    {
      type: "emit" as const,
      event: {
        type: "SESSION_LAUNCHED",
        registrationId: { select: ["context", "registrationId"] },
        actor: { select: ["context", "actor"] },
        sessionId: { ref: "sessionId" },
        auId: { select: ["event", "auId"] },
        launchMode: { select: ["event", "launchMode"] },
        fetchToken: { select: ["event", "fetchToken"] },
        launchedAt: { select: ["event", "timestamp"] },
      },
    },
  ],
};

const satisfyBlock = {
  type: "enqueueActions" as const,
  let: {
    timestamp: { fn: ["now"] },
    blockTitle: { coalesce: [
      { select: ["context", "metadata", "blockTitles", { param: "blockId" }] },
      { param: "blockId" },
    ]},
    sessionId: { coalesce: [
      { select: ["context", "lastSatisfyingSessionId"] },
      { fn: ["uuid"] },
    ]},
  },
  actions: [
    {
      guard: { not: { in: [{ param: "blockId" }, { select: ["context", "satisfiedBlocks"] }] } },
      actions: [
        {
          type: "assign" as const,
          transforms: [
            { path: ["satisfiedBlocks"], append: { param: "blockId" } },
          ],
        },
        {
          type: "emit" as const,
          event: {
            type: "EMIT_SATISFIED_BLOCK",
            registrationId: { select: ["context", "registrationId"] },
            actor: { select: ["context", "actor"] },
            blockId: { param: "blockId" },
            blockTitle: { ref: "blockTitle" },
            sessionId: { ref: "sessionId" },
            timestamp: { ref: "timestamp" },
          },
        },
      ],
    },
  ],
};

const satisfyCourse = {
  type: "enqueueActions" as const,
  let: {
    timestamp: { fn: ["now"] },
    sessionId: { coalesce: [
      { select: ["context", "lastSatisfyingSessionId"] },
      { fn: ["uuid"] },
    ]},
  },
  actions: [
    {
      type: "assign" as const,
      transforms: [
        { path: ["courseSatisfied"], set: true },
        { path: ["courseSatisfiedAt"], set: { ref: "timestamp" } },
      ],
    },
    {
      type: "emit" as const,
      event: {
        type: "EMIT_SATISFIED_COURSE",
        registrationId: { select: ["context", "registrationId"] },
        actor: { select: ["context", "actor"] },
        courseId: { select: ["context", "metadata", "courseId"] },
        courseTitle: { select: ["context", "metadata", "courseTitle"] },
        sessionId: { ref: "sessionId" },
        timestamp: { ref: "timestamp" },
      },
    },
  ],
};

const handleTerminated = {
  type: "enqueueActions" as const,
  let: {
    sessionId: { select: ["event", "sessionId"] },
    session: { select: ["context", "sessions", { ref: "sessionId" }] },
    auTitle: { coalesce: [
      { select: ["context", "metadata", "auTitles", { select: ["session", "auId"] }] },
      { select: ["session", "auId"] },
    ]},
  },
  actions: [
    {
      guard: { not: { isNull: { ref: "session" } } },
      actions: [
        {
          type: "assign" as const,
          transforms: [
            { path: ["sessions", { ref: "sessionId" }, "state"], set: "terminated" },
            { path: ["sessions", { ref: "sessionId" }, "terminatedAt"],
              set: { select: ["event", "timestamp"] } },
          ],
        },
        {
          type: "emit" as const,
          event: {
            type: "SESSION_TERMINATED",
            registrationId: { select: ["context", "registrationId"] },
            actor: { select: ["context", "actor"] },
            sessionId: { select: ["event", "sessionId"] },
            auId: { select: ["session", "auId"] },
            auTitle: { ref: "auTitle" },
            timestamp: { select: ["event", "timestamp"] },
          },
        },
      ],
    },
  ],
};

// ─── Tests: verbSatisfiesAU guard ─────────────────────────────────────────────

describe("guard: verbSatisfiesAU", () => {
  it("Completed verb + Completed moveOn → true", () => {
    const scope = createScope({
      context: makeRegistrationContext(),
      event: { auId: "au-1", verbId: "http://adlnet.gov/expapi/verbs/completed", score: null },
      params: { auId: "au-1", moveOn: "Completed", masteryScore: 80, verbId: "http://adlnet.gov/expapi/verbs/completed" },
    });
    expect(evaluate(verbSatisfiesAU, scope, defaultBuiltins)).toBe(true);
  });

  it("Wrong auId → false", () => {
    const scope = createScope({
      context: makeRegistrationContext(),
      event: { auId: "au-2", verbId: "http://adlnet.gov/expapi/verbs/completed", score: null },
      params: { auId: "au-1", moveOn: "Completed", masteryScore: 80, verbId: "http://adlnet.gov/expapi/verbs/completed" },
    });
    expect(evaluate(verbSatisfiesAU, scope, defaultBuiltins)).toBe(false);
  });

  it("Passed verb with score >= masteryScore + Passed moveOn → true", () => {
    const scope = createScope({
      context: makeRegistrationContext(),
      event: { auId: "au-1", verbId: "http://adlnet.gov/expapi/verbs/passed", score: 90 },
      params: { auId: "au-1", moveOn: "Passed", masteryScore: 80, verbId: "http://adlnet.gov/expapi/verbs/passed" },
    });
    expect(evaluate(verbSatisfiesAU, scope, defaultBuiltins)).toBe(true);
  });

  it("Passed verb with score < masteryScore + Passed moveOn → false", () => {
    const scope = createScope({
      context: makeRegistrationContext(),
      event: { auId: "au-1", verbId: "http://adlnet.gov/expapi/verbs/passed", score: 70 },
      params: { auId: "au-1", moveOn: "Passed", masteryScore: 80, verbId: "http://adlnet.gov/expapi/verbs/passed" },
    });
    expect(evaluate(verbSatisfiesAU, scope, defaultBuiltins)).toBe(false);
  });

  it("CompletedOrPassed when AU already completed → true", () => {
    const scope = createScope({
      context: makeRegistrationContext(),
      // au-2 already has hasCompleted: true
      event: { auId: "au-2", verbId: "http://adlnet.gov/expapi/verbs/experienced", score: null },
      params: { auId: "au-2", moveOn: "CompletedOrPassed", masteryScore: 80, verbId: "http://adlnet.gov/expapi/verbs/experienced" },
    });
    expect(evaluate(verbSatisfiesAU, scope, defaultBuiltins)).toBe(true);
  });

  it("Passed verb with no score (null) + Passed moveOn → true (isNull bypasses score check)", () => {
    const scope = createScope({
      context: makeRegistrationContext(),
      event: { auId: "au-1", verbId: "http://adlnet.gov/expapi/verbs/passed", score: null },
      params: { auId: "au-1", moveOn: "Passed", masteryScore: 80, verbId: "http://adlnet.gov/expapi/verbs/passed" },
    });
    expect(evaluate(verbSatisfiesAU, scope, defaultBuiltins)).toBe(true);
  });
});

// ─── Tests: waiveTargetsAU guard ─────────────────────────────────────────────

describe("guard: waiveTargetsAU", () => {
  it("WAIVED event matching auId → true", () => {
    const scope = createScope({
      context: makeRegistrationContext(),
      event: { type: "WAIVED", auId: "au-1" },
      params: { auId: "au-1" },
    });
    expect(evaluate(waiveTargetsAU, scope, defaultBuiltins)).toBe(true);
  });

  it("WAIVED event with wrong auId → false", () => {
    const scope = createScope({
      context: makeRegistrationContext(),
      event: { type: "WAIVED", auId: "au-2" },
      params: { auId: "au-1" },
    });
    expect(evaluate(waiveTargetsAU, scope, defaultBuiltins)).toBe(false);
  });

  it("Wrong event type → false", () => {
    const scope = createScope({
      context: makeRegistrationContext(),
      event: { type: "COMPLETED", auId: "au-1" },
      params: { auId: "au-1" },
    });
    expect(evaluate(waiveTargetsAU, scope, defaultBuiltins)).toBe(false);
  });
});

// ─── Tests: signoffTargetsAU guard ───────────────────────────────────────────

describe("guard: signoffTargetsAU", () => {
  it("SIGNOFF_APPROVED + matching auId → true", () => {
    const scope = createScope({
      context: makeRegistrationContext(),
      event: { type: "SIGNOFF_APPROVED", auId: "au-1" },
      params: { auId: "au-1" },
    });
    expect(evaluate(signoffTargetsAU, scope, defaultBuiltins)).toBe(true);
  });

  it("SIGNOFF_RETURNED + matching auId → true", () => {
    const scope = createScope({
      context: makeRegistrationContext(),
      event: { type: "SIGNOFF_RETURNED", auId: "au-1" },
      params: { auId: "au-1" },
    });
    expect(evaluate(signoffTargetsAU, scope, defaultBuiltins)).toBe(true);
  });

  it("Wrong event type → false", () => {
    const scope = createScope({
      context: makeRegistrationContext(),
      event: { type: "WAIVED", auId: "au-1" },
      params: { auId: "au-1" },
    });
    expect(evaluate(signoffTargetsAU, scope, defaultBuiltins)).toBe(false);
  });
});

// ─── Tests: satisfyAU action ──────────────────────────────────────────────────

describe("action: satisfyAU", () => {
  const testBuiltins = createBuiltinRegistry({
    uuid: () => "test-uuid-123",
    now: () => 1718452800000,
  });

  it("Passed verb with score → assign + score assign + EMIT_AU_PASSED + EMIT_SATISFIED_AU (4 results)", () => {
    const scope = createScope({
      context: makeRegistrationContext(),
      event: {
        auId: "au-1",
        verbId: "http://adlnet.gov/expapi/verbs/passed",
        score: 90,
        sessionId: "session-abc",
        timestamp: 1718452800000,
      },
      params: {
        auId: "au-1",
        moveOn: "Passed",
        masteryScore: 80,
        verbId: "http://adlnet.gov/expapi/verbs/passed",
      },
    });

    const results = evaluateActions(satisfyAU, scope, testBuiltins);
    expect(results).toHaveLength(4);

    // Result 0: assign — flags updated
    expect(results[0].type).toBe("assign");
    const ctx0 = (results[0] as { type: "assign"; context: Record<string, unknown> }).context;
    const au1 = (ctx0.aus as Record<string, unknown>)["au-1"] as Record<string, unknown>;
    expect(au1.hasPassed).toBe(true);
    expect(au1.hasCompleted).toBe(false);
    expect(au1.method).toBe("passed");
    expect(au1.satisfiedAt).toBe(1718452800000);
    expect(ctx0.lastSatisfyingSessionId).toBe("session-abc");

    // Result 1: guarded assign — score set
    expect(results[1].type).toBe("assign");
    const ctx1 = (results[1] as { type: "assign"; context: Record<string, unknown> }).context;
    const au1b = (ctx1.aus as Record<string, unknown>)["au-1"] as Record<string, unknown>;
    expect(au1b.score).toEqual({ scaled: 90 });

    // Result 2: EMIT_AU_PASSED
    expect(results[2].type).toBe("emit");
    const emit2 = (results[2] as { type: "emit"; event: Record<string, unknown> }).event;
    expect(emit2.type).toBe("EMIT_AU_PASSED");
    expect(emit2.auId).toBe("au-1");
    expect(emit2.registrationId).toBe("reg-1");
    expect(emit2.score).toBe(90);
    expect(emit2.sessionId).toBe("session-abc");

    // Result 3: EMIT_SATISFIED_AU
    expect(results[3].type).toBe("emit");
    const emit3 = (results[3] as { type: "emit"; event: Record<string, unknown> }).event;
    expect(emit3.type).toBe("EMIT_SATISFIED_AU");
    expect(emit3.auId).toBe("au-1");
  });

  it("Already hasPassed → assign + EMIT_SATISFIED_AU only (2 results)", () => {
    const scope = createScope({
      context: makeRegistrationContext({
        aus: {
          "au-1": { hasCompleted: false, hasPassed: true, hasFailed: false, method: "passed", satisfiedAt: 123, score: null },
          "au-2": { hasCompleted: true, hasPassed: false, hasFailed: false, method: null, satisfiedAt: null, score: null },
        },
      }),
      event: {
        auId: "au-1",
        verbId: "http://adlnet.gov/expapi/verbs/passed",
        score: null,
        sessionId: null,
        timestamp: null,
      },
      params: {
        auId: "au-1",
        moveOn: "Passed",
        masteryScore: 80,
        verbId: "http://adlnet.gov/expapi/verbs/passed",
      },
    });

    const results = evaluateActions(satisfyAU, scope, testBuiltins);
    // score is null → no score assign; hasPassed already true → no EMIT_AU_PASSED
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe("assign");
    expect(results[1].type).toBe("emit");
    const emit = (results[1] as { type: "emit"; event: Record<string, unknown> }).event;
    expect(emit.type).toBe("EMIT_SATISFIED_AU");
  });
});

// ─── Tests: handleSessionLaunch action ───────────────────────────────────────

describe("action: handleSessionLaunch", () => {
  it("abandons active/launched sessions, creates new session, emits events", () => {
    const context = makeRegistrationContext({
      sessions: {
        "s-1": { state: "launched", auId: "au-1", launchMode: "Normal", launchedAt: 100 },
        "s-2": { state: "terminated", auId: "au-1", launchMode: "Normal", launchedAt: 50 },
        "s-3": { state: "active", auId: "au-2", launchMode: "Browse", launchedAt: 200 },
      },
    });

    const scope = createScope({
      context,
      event: {
        sessionId: "s-4",
        auId: "au-1",
        launchMode: "Normal",
        timestamp: 300,
        fetchToken: "tok-abc",
      },
      params: {},
    });

    const results = evaluateActions(handleSessionLaunch, scope, defaultBuiltins);
    expect(results).toHaveLength(3);

    // Result 0: SESSIONS_ABANDONED emit — sessions filtered to launched + active
    expect(results[0].type).toBe("emit");
    const emit0 = (results[0] as { type: "emit"; event: Record<string, unknown> }).event;
    expect(emit0.type).toBe("SESSIONS_ABANDONED");
    const abandonedSessions = emit0.sessions as Record<string, unknown>;
    expect(Object.keys(abandonedSessions)).toHaveLength(2);
    expect(abandonedSessions).toHaveProperty("s-1");
    expect(abandonedSessions).toHaveProperty("s-3");
    expect(abandonedSessions).not.toHaveProperty("s-2");

    // Result 1: assign — s-1 and s-3 now abandoned; s-2 unchanged; s-4 newly launched
    expect(results[1].type).toBe("assign");
    const ctx1 = (results[1] as { type: "assign"; context: Record<string, unknown> }).context;
    const sessions = ctx1.sessions as Record<string, Record<string, unknown>>;
    expect(sessions["s-1"].state).toBe("abandoned");
    expect(sessions["s-2"].state).toBe("terminated"); // unchanged
    expect(sessions["s-3"].state).toBe("abandoned");
    expect(sessions["s-4"]).toEqual({
      state: "launched",
      auId: "au-1",
      launchMode: "Normal",
      launchedAt: 300,
      fetchToken: "tok-abc",
    });

    // Result 2: SESSION_LAUNCHED emit
    expect(results[2].type).toBe("emit");
    const emit2 = (results[2] as { type: "emit"; event: Record<string, unknown> }).event;
    expect(emit2.type).toBe("SESSION_LAUNCHED");
    expect(emit2.sessionId).toBe("s-4");
    expect(emit2.auId).toBe("au-1");
    expect(emit2.launchMode).toBe("Normal");
    expect(emit2.fetchToken).toBe("tok-abc");
    expect(emit2.launchedAt).toBe(300);
  });
});

// ─── Tests: satisfyBlock action ───────────────────────────────────────────────

describe("action: satisfyBlock", () => {
  const testBuiltins = createBuiltinRegistry({
    uuid: () => "test-uuid-123",
    now: () => 1718452800000,
  });

  it("Block not yet satisfied → assign (append) + EMIT_SATISFIED_BLOCK (2 results)", () => {
    const scope = createScope({
      context: makeRegistrationContext({
        lastSatisfyingSessionId: "session-xyz",
      }),
      event: {},
      params: { blockId: "block-1" },
    });

    const results = evaluateActions(satisfyBlock, scope, testBuiltins);
    expect(results).toHaveLength(2);

    // assign — block appended
    expect(results[0].type).toBe("assign");
    const ctx = (results[0] as { type: "assign"; context: Record<string, unknown> }).context;
    expect(ctx.satisfiedBlocks).toEqual(["block-1"]);

    // emit — EMIT_SATISFIED_BLOCK
    expect(results[1].type).toBe("emit");
    const emit = (results[1] as { type: "emit"; event: Record<string, unknown> }).event;
    expect(emit.type).toBe("EMIT_SATISFIED_BLOCK");
    expect(emit.blockId).toBe("block-1");
    expect(emit.blockTitle).toBe("Block 1"); // from metadata.blockTitles
    expect(emit.sessionId).toBe("session-xyz");
    expect(emit.timestamp).toBe(1718452800000);
  });

  it("Block already in satisfiedBlocks → guard false, 0 results", () => {
    const scope = createScope({
      context: makeRegistrationContext({
        satisfiedBlocks: ["block-1"],
      }),
      event: {},
      params: { blockId: "block-1" },
    });

    const results = evaluateActions(satisfyBlock, scope, testBuiltins);
    expect(results).toHaveLength(0);
  });
});

// ─── Tests: satisfyCourse action ──────────────────────────────────────────────

describe("action: satisfyCourse", () => {
  const testBuiltins = createBuiltinRegistry({
    uuid: () => "test-uuid-123",
    now: () => 1718452800000,
  });

  it("produces assign (courseSatisfied=true) + EMIT_SATISFIED_COURSE", () => {
    const scope = createScope({
      context: makeRegistrationContext({
        lastSatisfyingSessionId: "session-xyz",
      }),
      event: {},
      params: {},
    });

    const results = evaluateActions(satisfyCourse, scope, testBuiltins);
    expect(results).toHaveLength(2);

    // assign
    expect(results[0].type).toBe("assign");
    const ctx = (results[0] as { type: "assign"; context: Record<string, unknown> }).context;
    expect(ctx.courseSatisfied).toBe(true);
    expect(ctx.courseSatisfiedAt).toBe(1718452800000);

    // emit
    expect(results[1].type).toBe("emit");
    const emit = (results[1] as { type: "emit"; event: Record<string, unknown> }).event;
    expect(emit.type).toBe("EMIT_SATISFIED_COURSE");
    expect(emit.registrationId).toBe("reg-1");
    expect(emit.courseId).toBe("course-1");
    expect(emit.courseTitle).toBe("Test Course");
    expect(emit.sessionId).toBe("session-xyz");
    expect(emit.timestamp).toBe(1718452800000);
  });
});

// ─── Tests: handleTerminated action ───────────────────────────────────────────

describe("action: handleTerminated", () => {
  it("Session exists → assign + SESSION_TERMINATED emit (2 results)", () => {
    const scope = createScope({
      context: makeRegistrationContext({
        sessions: {
          "s-1": { state: "active", auId: "au-1", launchMode: "Normal", launchedAt: 100 },
        },
      }),
      event: { sessionId: "s-1", timestamp: 999 },
      params: {},
    });

    const results = evaluateActions(handleTerminated, scope, defaultBuiltins);
    expect(results).toHaveLength(2);

    // assign
    expect(results[0].type).toBe("assign");
    const ctx = (results[0] as { type: "assign"; context: Record<string, unknown> }).context;
    const sessions = ctx.sessions as Record<string, Record<string, unknown>>;
    expect(sessions["s-1"].state).toBe("terminated");
    expect(sessions["s-1"].terminatedAt).toBe(999);

    // emit
    expect(results[1].type).toBe("emit");
    const emit = (results[1] as { type: "emit"; event: Record<string, unknown> }).event;
    expect(emit.type).toBe("SESSION_TERMINATED");
    expect(emit.sessionId).toBe("s-1");
    expect(emit.auId).toBe("au-1");
    expect(emit.auTitle).toBe("Lesson 1"); // from metadata.auTitles["au-1"]
    expect(emit.timestamp).toBe(999);
  });

  it("Session doesn't exist → guard false, 0 results", () => {
    const scope = createScope({
      context: makeRegistrationContext({
        sessions: {},
      }),
      event: { sessionId: "s-nonexistent", timestamp: 999 },
      params: {},
    });

    const results = evaluateActions(handleTerminated, scope, defaultBuiltins);
    expect(results).toHaveLength(0);
  });
});
