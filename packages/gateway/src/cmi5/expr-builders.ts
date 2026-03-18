// Guard and action expression builders for the CMI5 registration machine.
// These produce JSON-serializable expr data compiled at machine creation time.

// ─── Shared let bindings ───────────────────────────────────────────────────

function computeNextFlagsLet(): Record<string, unknown> {
  return {
    current: { select: ["context", "aus", { param: "auId" }] },
    score: { select: ["event", "score"] },
    nextHasCompleted: { or: [
      { select: ["current", "hasCompleted"] },
      { eq: [{ select: ["event", "verbId"] }, "http://adlnet.gov/expapi/verbs/completed"] },
    ] },
    nextHasPassed: { or: [
      { select: ["current", "hasPassed"] },
      { and: [
        { eq: [{ select: ["event", "verbId"] }, "http://adlnet.gov/expapi/verbs/passed"] },
        { if: [{ isNull: { select: ["event", "score"] } }, true, { gte: [{ select: ["event", "score"] }, { param: "masteryScore" }] }] },
      ] },
    ] },
    nextHasFailed: { or: [
      { select: ["current", "hasFailed"] },
      { eq: [{ select: ["event", "verbId"] }, "http://adlnet.gov/expapi/verbs/failed"] },
    ] },
  };
}

function isSatisfiedCond(): unknown {
  return { cond: [
    [{ eq: [{ param: "moveOn" }, "Completed"] }, { ref: "nextHasCompleted" }],
    [{ eq: [{ param: "moveOn" }, "Passed"] }, { ref: "nextHasPassed" }],
    [{ eq: [{ param: "moveOn" }, "CompletedAndPassed"] }, { and: [{ ref: "nextHasCompleted" }, { ref: "nextHasPassed" }] }],
    [{ eq: [{ param: "moveOn" }, "CompletedOrPassed"] }, { or: [{ ref: "nextHasCompleted" }, { ref: "nextHasPassed" }] }],
    [{ eq: [{ param: "moveOn" }, "NotApplicable"] }, true],
    [true, false],
  ] };
}

function methodCond(): unknown {
  return { cond: [
    [{ eq: [{ param: "moveOn" }, "Completed"] }, "completed"],
    [{ eq: [{ param: "moveOn" }, "Passed"] }, "passed"],
    [{ eq: [{ param: "moveOn" }, "CompletedAndPassed"] }, "completedAndPassed"],
    [{ eq: [{ param: "moveOn" }, "CompletedOrPassed"] }, { if: [{ ref: "nextHasPassed" }, "passed", "completed"] }],
    [{ eq: [{ param: "moveOn" }, "NotApplicable"] }, "notApplicable"],
    [true, null],
  ] };
}

// ─── Guards ────────────────────────────────────────────────────────────────

export function buildGuards(): Record<string, unknown> {
  return {
    verbSatisfiesAU: {
      let: [computeNextFlagsLet(), { and: [
        { eq: [{ select: ["event", "auId"] }, { param: "auId" }] },
        isSatisfiedCond(),
      ] }],
    },
    verbUpdatesAU: {
      let: [{ ...computeNextFlagsLet(), isSatisfied: isSatisfiedCond() }, { and: [
        { eq: [{ select: ["event", "auId"] }, { param: "auId" }] },
        { not: { ref: "isSatisfied" } },
        { or: [
          { neq: [{ ref: "nextHasCompleted" }, { select: ["current", "hasCompleted"] }] },
          { neq: [{ ref: "nextHasPassed" }, { select: ["current", "hasPassed"] }] },
          { neq: [{ ref: "nextHasFailed" }, { select: ["current", "hasFailed"] }] },
        ] },
      ] }],
    },
    waiveTargetsAU: {
      and: [
        { eq: [{ select: ["event", "type"] }, "WAIVED"] },
        { eq: [{ select: ["event", "auId"] }, { param: "auId" }] },
      ],
    },
    signoffTargetsAU: {
      and: [
        { in: [{ select: ["event", "type"] }, ["SIGNOFF_APPROVED", "SIGNOFF_RETURNED"]] },
        { eq: [{ select: ["event", "auId"] }, { param: "auId" }] },
      ],
    },
  };
}

// ─── AU actions ────────────────────────────────────────────────────────────

export function buildAUActions(): Record<string, unknown> {
  return {
    satisfyAU: buildSatisfyAUAction(),
    updateAU: buildUpdateAUAction(),
    waiveAU: buildWaiveAUAction(),
    satisfyNotApplicableAU: buildSatisfyNotApplicableAUAction(),
  };
}

function buildSatisfyAUAction(): unknown {
  return {
    type: "enqueueActions",
    let: {
      ...computeNextFlagsLet(),
      sessionId: { coalesce: [{ select: ["event", "sessionId"] }, { fn: ["uuid"] }] },
      timestamp: { coalesce: [{ select: ["event", "timestamp"] }, { fn: ["now"] }] },
      auTitle: { coalesce: [{ select: ["context", "metadata", "auTitles", { param: "auId" }] }, { param: "auId" }] },
      method: methodCond(),
    },
    actions: [
      { type: "assign", transforms: [
        { path: ["aus", { param: "auId" }, "hasCompleted"], set: { ref: "nextHasCompleted" } },
        { path: ["aus", { param: "auId" }, "hasPassed"], set: { ref: "nextHasPassed" } },
        { path: ["aus", { param: "auId" }, "hasFailed"], set: { ref: "nextHasFailed" } },
        { path: ["aus", { param: "auId" }, "method"], set: { ref: "method" } },
        { path: ["aus", { param: "auId" }, "satisfiedAt"], set: { ref: "timestamp" } },
        { path: ["lastSatisfyingSessionId"], set: { ref: "sessionId" } },
      ] },
      { guard: { not: { isNull: { ref: "score" } } }, actions: [
        { type: "assign", transforms: [{ path: ["aus", { param: "auId" }, "score"], set: { object: { scaled: { ref: "score" } } } }] },
      ] },
      { guard: { and: [{ ref: "nextHasPassed" }, { not: { select: ["current", "hasPassed"] } }] }, actions: [
        { type: "emit", event: { type: "EMIT_AU_PASSED", ...auEventFields() } },
      ] },
      { type: "emit", event: { type: "EMIT_SATISFIED_AU", ...auEventFields() } },
    ],
  };
}

function buildUpdateAUAction(): unknown {
  return {
    type: "enqueueActions",
    let: {
      ...computeNextFlagsLet(),
      sessionId: { coalesce: [{ select: ["event", "sessionId"] }, { fn: ["uuid"] }] },
      timestamp: { coalesce: [{ select: ["event", "timestamp"] }, { fn: ["now"] }] },
      auTitle: { coalesce: [{ select: ["context", "metadata", "auTitles", { param: "auId" }] }, { param: "auId" }] },
    },
    actions: [
      { type: "assign", transforms: [
        { path: ["aus", { param: "auId" }, "hasCompleted"], set: { ref: "nextHasCompleted" } },
        { path: ["aus", { param: "auId" }, "hasPassed"], set: { ref: "nextHasPassed" } },
        { path: ["aus", { param: "auId" }, "hasFailed"], set: { ref: "nextHasFailed" } },
      ] },
      { guard: { not: { isNull: { ref: "score" } } }, actions: [
        { type: "assign", transforms: [{ path: ["aus", { param: "auId" }, "score"], set: { object: { scaled: { ref: "score" } } } }] },
      ] },
      { guard: { and: [{ ref: "nextHasPassed" }, { not: { select: ["current", "hasPassed"] } }] }, actions: [
        { type: "emit", event: { type: "EMIT_AU_PASSED", ...auEventFields(), score: { ref: "score" } } },
      ] },
      { guard: { and: [{ ref: "nextHasFailed" }, { not: { select: ["current", "hasFailed"] } }] }, actions: [
        { type: "emit", event: { type: "EMIT_AU_FAILED", ...auEventFields(), score: { ref: "score" } } },
      ] },
    ],
  };
}

function buildWaiveAUAction(): unknown {
  return {
    type: "enqueueActions",
    let: {
      sessionId: { fn: ["uuid"] },
      timestamp: { coalesce: [{ select: ["event", "timestamp"] }, { fn: ["now"] }] },
      reason: { coalesce: [{ select: ["event", "reason"] }, "Administrative"] },
      auTitle: { coalesce: [{ select: ["context", "metadata", "auTitles", { param: "auId" }] }, { param: "auId" }] },
    },
    actions: [
      { type: "assign", transforms: [
        { path: ["aus", { param: "auId" }, "hasWaived"], set: true },
        { path: ["aus", { param: "auId" }, "method"], set: "waived" },
        { path: ["aus", { param: "auId" }, "satisfiedAt"], set: { ref: "timestamp" } },
        { path: ["lastSatisfyingSessionId"], set: { ref: "sessionId" } },
      ] },
      { type: "emit", event: {
        type: "EMIT_WAIVED", ...auEventFields(), reason: { ref: "reason" },
      } },
      { type: "emit", event: { type: "EMIT_SATISFIED_AU", ...auEventFields() } },
    ],
  };
}

function buildSatisfyNotApplicableAUAction(): unknown {
  return {
    type: "enqueueActions",
    let: {
      sessionId: { fn: ["uuid"] },
      timestamp: { fn: ["now"] },
      auTitle: { coalesce: [{ select: ["context", "metadata", "auTitles", { param: "auId" }] }, { param: "auId" }] },
    },
    actions: [
      { type: "assign", transforms: [
        { path: ["aus", { param: "auId" }, "method"], set: "notApplicable" },
        { path: ["aus", { param: "auId" }, "satisfiedAt"], set: { ref: "timestamp" } },
        { path: ["lastSatisfyingSessionId"], set: { ref: "sessionId" } },
      ] },
      { type: "emit", event: { type: "EMIT_SATISFIED_AU", ...auEventFields() } },
    ],
  };
}

function auEventFields(): Record<string, unknown> {
  return {
    registrationId: { select: ["context", "registrationId"] },
    actor: { select: ["context", "actor"] },
    auId: { param: "auId" },
    auTitle: { ref: "auTitle" },
    sessionId: { ref: "sessionId" },
    timestamp: { ref: "timestamp" },
  };
}

// ─── Assessment actions ──────────────────────────────────────────────────

export function buildAssessmentActions(): Record<string, unknown> {
  return {
    requestSignoff: buildRequestSignoffAction(),
    approveAssessment: buildApproveAssessmentAction(),
    returnAssessment: buildReturnAssessmentAction(),
  };
}

function buildRequestSignoffAction(): unknown {
  return {
    type: "enqueueActions",
    let: {
      ...computeNextFlagsLet(),
      sessionId: { coalesce: [{ select: ["event", "sessionId"] }, { fn: ["uuid"] }] },
      timestamp: { coalesce: [{ select: ["event", "timestamp"] }, { fn: ["now"] }] },
      auTitle: { coalesce: [{ select: ["context", "metadata", "auTitles", { param: "auId" }] }, { param: "auId" }] },
      method: methodCond(),
    },
    actions: [
      { type: "assign", transforms: [
        { path: ["aus", { param: "auId" }, "hasCompleted"], set: { ref: "nextHasCompleted" } },
        { path: ["aus", { param: "auId" }, "hasPassed"], set: { ref: "nextHasPassed" } },
        { path: ["aus", { param: "auId" }, "hasFailed"], set: { ref: "nextHasFailed" } },
        { path: ["aus", { param: "auId" }, "method"], set: { ref: "method" } },
        { path: ["lastSatisfyingSessionId"], set: { ref: "sessionId" } },
      ] },
      { guard: { not: { isNull: { ref: "score" } } }, actions: [
        { type: "assign", transforms: [{ path: ["aus", { param: "auId" }, "score"], set: { object: { scaled: { ref: "score" } } } }] },
      ] },
      { guard: { and: [{ ref: "nextHasPassed" }, { not: { select: ["current", "hasPassed"] } }] }, actions: [
        { type: "emit", event: { type: "EMIT_AU_PASSED", ...auEventFields() } },
      ] },
      { type: "emit", event: {
        type: "ASSESSMENT_PENDING_SIGNOFF",
        ...auEventFields(),
        score: { ref: "score" },
      } },
    ],
  };
}

function buildApproveAssessmentAction(): unknown {
  return {
    type: "enqueueActions",
    let: {
      timestamp: { coalesce: [{ select: ["event", "timestamp"] }, { fn: ["now"] }] },
      sessionId: { coalesce: [{ select: ["context", "lastSatisfyingSessionId"] }, { fn: ["uuid"] }] },
      auTitle: { coalesce: [{ select: ["context", "metadata", "auTitles", { param: "auId" }] }, { param: "auId" }] },
    },
    actions: [
      { type: "assign", transforms: [
        { path: ["aus", { param: "auId" }, "satisfiedAt"], set: { ref: "timestamp" } },
        { path: ["lastSatisfyingSessionId"], set: { ref: "sessionId" } },
      ] },
      { type: "emit", event: { type: "EMIT_SATISFIED_AU", ...auEventFields() } },
    ],
  };
}

function buildReturnAssessmentAction(): unknown {
  return {
    type: "enqueueActions",
    let: {
      timestamp: { coalesce: [{ select: ["event", "timestamp"] }, { fn: ["now"] }] },
      auTitle: { coalesce: [{ select: ["context", "metadata", "auTitles", { param: "auId" }] }, { param: "auId" }] },
    },
    actions: [
      { type: "assign", transforms: [
        { path: ["aus", { param: "auId" }, "hasCompleted"], set: false },
        { path: ["aus", { param: "auId" }, "hasPassed"], set: false },
        { path: ["aus", { param: "auId" }, "hasFailed"], set: false },
        { path: ["aus", { param: "auId" }, "method"], set: null },
        { path: ["aus", { param: "auId" }, "score"], set: null },
      ] },
      { type: "emit", event: {
        type: "ASSESSMENT_RETURNED",
        registrationId: { select: ["context", "registrationId"] },
        actor: { select: ["context", "actor"] },
        auId: { param: "auId" },
        auTitle: { ref: "auTitle" },
        supervisorId: { coalesce: [{ select: ["event", "supervisorId"] }, "unknown"] },
        reason: { select: ["event", "reason"] },
        timestamp: { ref: "timestamp" },
      } },
    ],
  };
}

// ─── Completion actions ────────────────────────────────────────────────────

export function buildCompletionActions(): Record<string, unknown> {
  return {
    satisfyBlock: buildSatisfyBlockAction(),
    satisfyCourse: buildSatisfyCourseAction(),
  };
}

function buildSatisfyBlockAction(): unknown {
  return {
    type: "enqueueActions",
    let: {
      timestamp: { fn: ["now"] },
      blockTitle: { coalesce: [{ select: ["context", "metadata", "blockTitles", { param: "blockId" }] }, { param: "blockId" }] },
      sessionId: { coalesce: [{ select: ["context", "lastSatisfyingSessionId"] }, { fn: ["uuid"] }] },
    },
    actions: [
      { guard: { not: { in: [{ param: "blockId" }, { select: ["context", "satisfiedBlocks"] }] } }, actions: [
        { type: "assign", transforms: [{ path: ["satisfiedBlocks"], append: { param: "blockId" } }] },
        { type: "emit", event: {
          type: "EMIT_SATISFIED_BLOCK",
          registrationId: { select: ["context", "registrationId"] },
          actor: { select: ["context", "actor"] },
          blockId: { param: "blockId" },
          blockTitle: { ref: "blockTitle" },
          sessionId: { ref: "sessionId" },
          timestamp: { ref: "timestamp" },
        } },
      ] },
    ],
  };
}

function buildSatisfyCourseAction(): unknown {
  return {
    type: "enqueueActions",
    let: {
      timestamp: { fn: ["now"] },
      sessionId: { coalesce: [{ select: ["context", "lastSatisfyingSessionId"] }, { fn: ["uuid"] }] },
    },
    actions: [
      { type: "assign", transforms: [
        { path: ["courseSatisfied"], set: true },
        { path: ["courseSatisfiedAt"], set: { ref: "timestamp" } },
      ] },
      { type: "emit", event: {
        type: "EMIT_SATISFIED_COURSE",
        registrationId: { select: ["context", "registrationId"] },
        actor: { select: ["context", "actor"] },
        courseId: { select: ["context", "metadata", "courseId"] },
        courseTitle: { select: ["context", "metadata", "courseTitle"] },
        sessionId: { ref: "sessionId" },
        timestamp: { ref: "timestamp" },
      } },
    ],
  };
}

// ─── Session actions ───────────────────────────────────────────────────────

export function buildSessionActions(): Record<string, unknown> {
  return {
    handleSessionLaunch: buildHandleSessionLaunchAction(),
    handleFetchTokenRetrieved: buildHandleFetchTokenRetrievedAction(),
    handleInitialized: buildHandleInitializedAction(),
    handleTerminated: buildHandleTerminatedAction(),
    handleSessionTimeout: buildHandleSessionTimeoutAction(),
    handleAnswered: buildHandleAnsweredAction(),
  };
}

function sessionLet(): Record<string, unknown> {
  return {
    sessionId: { select: ["event", "sessionId"] },
    session: { select: ["context", "sessions", { select: ["event", "sessionId"] }] },
  };
}

function buildHandleSessionLaunchAction(): unknown {
  return {
    type: "enqueueActions",
    let: { sessionId: { select: ["event", "sessionId"] } },
    actions: [
      { type: "emit", event: {
        type: "SESSIONS_ABANDONED",
        registrationId: { select: ["context", "registrationId"] },
        actor: { select: ["context", "actor"] },
        timestamp: { select: ["event", "timestamp"] },
        sessions: { select: ["context", "sessions", { where: { in: ["state", ["launched", "active"]] } }] },
      } },
      { type: "assign", transforms: [
        { path: ["sessions", { where: { in: ["state", ["launched", "active"]] } }, "state"], set: "abandoned" },
        { path: ["sessions", { ref: "sessionId" }], set: { object: {
          state: "launched",
          auId: { select: ["event", "auId"] },
          launchMode: { select: ["event", "launchMode"] },
          launchedAt: { select: ["event", "timestamp"] },
          fetchToken: { select: ["event", "fetchToken"] },
        } } },
        { path: ["activeSessionId"], set: { ref: "sessionId" } },
      ] },
      { type: "emit", event: {
        type: "SESSION_LAUNCHED",
        registrationId: { select: ["context", "registrationId"] },
        actor: { select: ["context", "actor"] },
        sessionId: { ref: "sessionId" },
        auId: { select: ["event", "auId"] },
        launchMode: { select: ["event", "launchMode"] },
        fetchToken: { select: ["event", "fetchToken"] },
        launchedAt: { select: ["event", "timestamp"] },
      } },
    ],
  };
}

function buildHandleFetchTokenRetrievedAction(): unknown {
  return {
    type: "enqueueActions",
    let: sessionLet(),
    actions: [
      { guard: { and: [
        { not: { isNull: { ref: "session" } } },
        { not: { isNull: { select: ["session", "fetchToken"] } } },
        { isNull: { select: ["session", "fetchTokenRetrievedAt"] } },
      ] }, actions: [
        { type: "assign", transforms: [
          { path: ["sessions", { ref: "sessionId" }, "fetchTokenRetrievedAt"], set: { select: ["event", "timestamp"] } },
        ] },
        { type: "emit", event: {
          type: "SESSION_TOKEN_RETRIEVED",
          sessionId: { select: ["event", "sessionId"] },
          auId: { select: ["session", "auId"] },
          registrationId: { select: ["context", "registrationId"] },
          timestamp: { select: ["event", "timestamp"] },
        } },
      ] },
    ],
  };
}

function buildHandleInitializedAction(): unknown {
  return {
    type: "enqueueActions",
    let: sessionLet(),
    actions: [
      { guard: { not: { isNull: { ref: "session" } } }, actions: [
        { type: "assign", transforms: [
          { path: ["sessions", { ref: "sessionId" }, "state"], set: "active" },
          { path: ["sessions", { ref: "sessionId" }, "initializedAt"], set: { select: ["event", "timestamp"] } },
        ] },
        { type: "emit", event: {
          type: "SESSION_INITIALIZED",
          sessionId: { select: ["event", "sessionId"] },
          auId: { select: ["session", "auId"] },
          registrationId: { select: ["context", "registrationId"] },
          timestamp: { select: ["event", "timestamp"] },
        } },
      ] },
    ],
  };
}

function buildHandleTerminatedAction(): unknown {
  return {
    type: "enqueueActions",
    let: {
      ...sessionLet(),
      auTitle: { coalesce: [
        { select: ["context", "metadata", "auTitles", { select: ["session", "auId"] }] },
        { select: ["session", "auId"] },
      ] },
    },
    actions: [
      { guard: { not: { isNull: { ref: "session" } } }, actions: [
        { type: "assign", transforms: [
          { path: ["sessions", { ref: "sessionId" }, "state"], set: "terminated" },
          { path: ["sessions", { ref: "sessionId" }, "terminatedAt"], set: { select: ["event", "timestamp"] } },
          { path: ["activeSessionId"], set: null },
        ] },
        { type: "emit", event: {
          type: "SESSION_TERMINATED",
          registrationId: { select: ["context", "registrationId"] },
          actor: { select: ["context", "actor"] },
          sessionId: { select: ["event", "sessionId"] },
          auId: { select: ["session", "auId"] },
          auTitle: { ref: "auTitle" },
          timestamp: { select: ["event", "timestamp"] },
        } },
      ] },
    ],
  };
}

function buildHandleSessionTimeoutAction(): unknown {
  // Reads activeSessionId from context (not event) so this works transparently
  // with XState `after` delayed transitions, which carry no custom payload.
  return {
    type: "enqueueActions",
    let: {
      sessionId: { select: ["context", "activeSessionId"] },
      session: { select: ["context", "sessions", { select: ["context", "activeSessionId"] }] },
      timestamp: { coalesce: [{ select: ["event", "timestamp"] }, { fn: ["now"] }] },
      auTitle: { coalesce: [
        { select: ["context", "metadata", "auTitles", { select: ["session", "auId"] }] },
        { select: ["session", "auId"] },
      ] },
    },
    actions: [
      { guard: { and: [
        { not: { isNull: { ref: "session" } } },
        { neq: [{ select: ["session", "state"] }, "terminated"] },
      ] }, actions: [
        { type: "assign", transforms: [
          { path: ["sessions", { ref: "sessionId" }, "state"], set: "abandoned" },
          { path: ["activeSessionId"], set: null },
        ] },
        { type: "emit", event: {
          type: "SESSION_ABANDONED",
          sessionId: { ref: "sessionId" },
          auId: { select: ["session", "auId"] },
          registrationId: { select: ["context", "registrationId"] },
          timestamp: { ref: "timestamp" },
        } },
        { type: "emit", event: {
          type: "EMIT_ABANDONED",
          registrationId: { select: ["context", "registrationId"] },
          actor: { select: ["context", "actor"] },
          auId: { select: ["session", "auId"] },
          auTitle: { ref: "auTitle" },
          sessionId: { ref: "sessionId" },
          timestamp: { ref: "timestamp" },
          duration: { fn: ["iso8601Duration",
            { select: ["session", "launchedAt"] },
            { ref: "timestamp" },
          ] },
        } },
      ] },
    ],
  };
}

function buildHandleAnsweredAction(): unknown {
  return {
    type: "enqueueActions",
    let: { session: { select: ["context", "sessions", { select: ["event", "sessionId"] }] } },
    actions: [
      { guard: { not: { isNull: { ref: "session" } } }, actions: [{
        type: "emit", event: {
          type: "EMIT_QUESTION_ANSWERED",
          registrationId: { select: ["context", "registrationId"] },
          actor: { select: ["context", "actor"] },
          auId: { select: ["session", "auId"] },
          sessionId: { select: ["event", "sessionId"] },
          timestamp: { select: ["event", "timestamp"] },
          score: { select: ["event", "score"] },
          success: { select: ["event", "success"] },
          objectiveId: { select: ["event", "objectiveId"] },
          response: { select: ["event", "response"] },
          sourceStatementId: { select: ["event", "sourceStatementId"] },
        },
      }] },
    ],
  };
}
