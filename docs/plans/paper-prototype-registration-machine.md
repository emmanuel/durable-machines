# Paper Prototype: Registration Machine as Data Expressions

Paper prototype of the CMI5 registration machine's guard and action implementations
expressed entirely as data expressions. Source: `registration-machine.ts` in lms-engine-integrations.

The topology (states, transitions, targets) is already 100% serialized by `machine.toJSON()`.
This prototype fills the gap: the **implementation bodies** of named guards and actions.

## Scope Variables

Every expression evaluates against:
- `context` — `RegistrationContext` (registrationId, actor, metadata, aus, sessions, satisfiedBlocks, courseSatisfied)
- `event` — the current `RegistrationEvent`
- `params` — static params from the transition config (e.g., `{ auId, moveOn, masteryScore, verbId }`)

`let` bindings extend the scope incrementally — each binding can reference earlier ones.

## Building Blocks

The refactored registration machine decomposes AU satisfaction into 3 small pure functions.
These map directly to reusable `let` binding patterns in data expressions:

### `computeNextFlags` → 3 boolean let bindings

```ts
// JS (12 lines)
computeNextFlags(au, verbId, masteryScore, score) → { hasCompleted, hasPassed, hasFailed }
```

```json
"nextHasCompleted": {"or": [
  {"select": ["current", "hasCompleted"]},
  {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/completed"]}
]},
"nextHasPassed": {"or": [
  {"select": ["current", "hasPassed"]},
  {"and": [
    {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/passed"]},
    {"if": [{"isNull": {"ref": "score"}}, true, {"gte": [{"ref": "score"}, {"param": "masteryScore"}]}]}
  ]}
]},
"nextHasFailed": {"or": [
  {"select": ["current", "hasFailed"]},
  {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/failed"]}
]}
```

### `meetsMoveOnCriteria` → one `cond`

```ts
// JS (8 lines)
meetsMoveOnCriteria(moveOn, hasCompleted, hasPassed) → boolean
```

```json
"isSatisfied": {"cond": [
  [{"eq": [{"param": "moveOn"}, "Completed"]},          {"ref": "nextHasCompleted"}],
  [{"eq": [{"param": "moveOn"}, "Passed"]},              {"ref": "nextHasPassed"}],
  [{"eq": [{"param": "moveOn"}, "CompletedAndPassed"]},  {"and": [{"ref": "nextHasCompleted"}, {"ref": "nextHasPassed"}]}],
  [{"eq": [{"param": "moveOn"}, "CompletedOrPassed"]},   {"or": [{"ref": "nextHasCompleted"}, {"ref": "nextHasPassed"}]}],
  [{"eq": [{"param": "moveOn"}, "NotApplicable"]},       true],
  [true, false]
]}
```

### `satisfactionMethodFor` → one `cond`

```ts
// JS (8 lines)
satisfactionMethodFor(moveOn, hasPassed) → SatisfactionMethod
```

```json
"method": {"cond": [
  [{"eq": [{"param": "moveOn"}, "Completed"]},          "completed"],
  [{"eq": [{"param": "moveOn"}, "Passed"]},              "passed"],
  [{"eq": [{"param": "moveOn"}, "CompletedAndPassed"]},  "completedAndPassed"],
  [{"eq": [{"param": "moveOn"}, "CompletedOrPassed"]},   {"if": [{"ref": "nextHasPassed"}, "passed", "completed"]}],
  [{"eq": [{"param": "moveOn"}, "NotApplicable"]},       "notApplicable"],
  [true, null]
]}
```

---

## Guards

### `waiveTargetsAU` (params: `{ auId }`)

```ts
({ event }, params) => event.type === 'WAIVED' && 'auId' in event && event.auId === params.auId
```

```json
{
  "and": [
    {"eq": [{"select": ["event", "type"]}, "WAIVED"]},
    {"eq": [{"select": ["event", "auId"]}, {"param": "auId"}]}
  ]
}
```

Clean, no gaps.

---

### `signoffTargetsAU` (params: `{ auId }`)

```ts
({ event }, params) =>
  (event.type === 'SIGNOFF_APPROVED' || event.type === 'SIGNOFF_RETURNED') &&
  'auId' in event && event.auId === params.auId
```

```json
{
  "and": [
    {"in": [{"select": ["event", "type"]}, ["SIGNOFF_APPROVED", "SIGNOFF_RETURNED"]]},
    {"eq": [{"select": ["event", "auId"]}, {"param": "auId"}]}
  ]
}
```

Clean.

---

### `verbSatisfiesAU` (params: `{ auId, moveOn, masteryScore, verbId }`)

```ts
({ context, event }, params) => {
  if ('auId' in event && event.auId !== params.auId) return false;
  const score = 'score' in event ? event.score : undefined;
  const next = computeNextFlags(context.aus[params.auId], params.verbId, params.masteryScore, score);
  return meetsMoveOnCriteria(params.moveOn, next.hasCompleted, next.hasPassed);
}
```

```json
{
  "let": {
    "current": {"select": ["context", "aus", {"param": "auId"}]},
    "score": {"select": ["event", "score"]},

    "nextHasCompleted": {"or": [
      {"select": ["current", "hasCompleted"]},
      {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/completed"]}
    ]},
    "nextHasPassed": {"or": [
      {"select": ["current", "hasPassed"]},
      {"and": [
        {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/passed"]},
        {"if": [{"isNull": {"ref": "score"}}, true, {"gte": [{"ref": "score"}, {"param": "masteryScore"}]}]}
      ]}
    ]}
  },
  "body": {"and": [
    {"eq": [{"select": ["event", "auId"]}, {"param": "auId"}]},
    {"cond": [
      [{"eq": [{"param": "moveOn"}, "Completed"]},          {"ref": "nextHasCompleted"}],
      [{"eq": [{"param": "moveOn"}, "Passed"]},              {"ref": "nextHasPassed"}],
      [{"eq": [{"param": "moveOn"}, "CompletedAndPassed"]},  {"and": [{"ref": "nextHasCompleted"}, {"ref": "nextHasPassed"}]}],
      [{"eq": [{"param": "moveOn"}, "CompletedOrPassed"]},   {"or": [{"ref": "nextHasCompleted"}, {"ref": "nextHasPassed"}]}],
      [{"eq": [{"param": "moveOn"}, "NotApplicable"]},       true],
      [true, false]
    ]}
  ]}
}
```

Notes:
- `isNull` operator needed for optional `event.score`
- Only needs `nextHasCompleted` and `nextHasPassed` — `nextHasFailed` irrelevant for satisfaction check
- Directly mirrors the decomposed `computeNextFlags` + `meetsMoveOnCriteria`

---

### `verbUpdatesAU` (params: `{ auId, moveOn, masteryScore, verbId }`)

```ts
({ context, event }, params) => {
  if ('auId' in event && event.auId !== params.auId) return false;
  const au = context.aus[params.auId];
  const score = 'score' in event ? event.score : undefined;
  const next = computeNextFlags(au, params.verbId, params.masteryScore, score);
  if (meetsMoveOnCriteria(params.moveOn, next.hasCompleted, next.hasPassed)) return false;
  return next.hasCompleted !== au.hasCompleted || next.hasPassed !== au.hasPassed || next.hasFailed !== au.hasFailed;
}
```

```json
{
  "let": {
    "current": {"select": ["context", "aus", {"param": "auId"}]},
    "score": {"select": ["event", "score"]},

    "nextHasCompleted": {"or": [
      {"select": ["current", "hasCompleted"]},
      {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/completed"]}
    ]},
    "nextHasPassed": {"or": [
      {"select": ["current", "hasPassed"]},
      {"and": [
        {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/passed"]},
        {"if": [{"isNull": {"ref": "score"}}, true, {"gte": [{"ref": "score"}, {"param": "masteryScore"}]}]}
      ]}
    ]},
    "nextHasFailed": {"or": [
      {"select": ["current", "hasFailed"]},
      {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/failed"]}
    ]},

    "isSatisfied": {"cond": [
      [{"eq": [{"param": "moveOn"}, "Completed"]},          {"ref": "nextHasCompleted"}],
      [{"eq": [{"param": "moveOn"}, "Passed"]},              {"ref": "nextHasPassed"}],
      [{"eq": [{"param": "moveOn"}, "CompletedAndPassed"]},  {"and": [{"ref": "nextHasCompleted"}, {"ref": "nextHasPassed"}]}],
      [{"eq": [{"param": "moveOn"}, "CompletedOrPassed"]},   {"or": [{"ref": "nextHasCompleted"}, {"ref": "nextHasPassed"}]}],
      [{"eq": [{"param": "moveOn"}, "NotApplicable"]},       true],
      [true, false]
    ]}
  },
  "body": {"and": [
    {"eq": [{"select": ["event", "auId"]}, {"param": "auId"}]},
    {"not": {"ref": "isSatisfied"}},
    {"or": [
      {"neq": [{"ref": "nextHasCompleted"}, {"select": ["current", "hasCompleted"]}]},
      {"neq": [{"ref": "nextHasPassed"}, {"select": ["current", "hasPassed"]}]},
      {"neq": [{"ref": "nextHasFailed"}, {"select": ["current", "hasFailed"]}]}
    ]}
  ]}
}
```

Clean. The flag bindings duplicate between guards — tolerable since each is one line.

---

## Actions

### `satisfyAU` (params: `{ auId, moveOn, masteryScore, verbId }`)

```ts
enqueueActions(({ context, event, enqueue }, params) => {
  const au = context.aus[params.auId];
  const score = 'score' in event ? event.score : undefined;
  const sessionId = 'sessionId' in event ? event.sessionId : generateSessionId();
  const timestamp = 'timestamp' in event ? event.timestamp : new Date().toISOString();
  const auTitle = context.metadata.auTitles[params.auId] ?? params.auId;
  const next = computeNextFlags(au, params.verbId, params.masteryScore, score);

  enqueue(assign({ aus: { ...context.aus, [params.auId]: {
    ...au, ...next,
    method: satisfactionMethodFor(params.moveOn, next.hasPassed),
    satisfiedAt: timestamp,
    ...(score !== undefined && { score: { scaled: score } }),
  }}, lastSatisfyingSessionId: sessionId }));

  if (next.hasPassed && !au.hasPassed) { enqueue(emit({ type: 'EMIT_AU_PASSED', ... })); }
  enqueue(emit({ type: 'EMIT_SATISFIED_AU', ... }));
});
```

```json
{
  "type": "enqueueActions",
  "let": {
    "current": {"select": ["context", "aus", {"param": "auId"}]},
    "score": {"select": ["event", "score"]},
    "sessionId": {"coalesce": [{"select": ["event", "sessionId"]}, {"fn": "uuid"}]},
    "timestamp": {"coalesce": [{"select": ["event", "timestamp"]}, {"fn": "now"}]},
    "auTitle": {"coalesce": [
      {"select": ["context", "metadata", "auTitles", {"param": "auId"}]},
      {"param": "auId"}
    ]},

    "nextHasCompleted": {"or": [
      {"select": ["current", "hasCompleted"]},
      {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/completed"]}
    ]},
    "nextHasPassed": {"or": [
      {"select": ["current", "hasPassed"]},
      {"and": [
        {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/passed"]},
        {"if": [{"isNull": {"ref": "score"}}, true, {"gte": [{"ref": "score"}, {"param": "masteryScore"}]}]}
      ]}
    ]},
    "nextHasFailed": {"or": [
      {"select": ["current", "hasFailed"]},
      {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/failed"]}
    ]},

    "method": {"cond": [
      [{"eq": [{"param": "moveOn"}, "Completed"]},          "completed"],
      [{"eq": [{"param": "moveOn"}, "Passed"]},              "passed"],
      [{"eq": [{"param": "moveOn"}, "CompletedAndPassed"]},  "completedAndPassed"],
      [{"eq": [{"param": "moveOn"}, "CompletedOrPassed"]},   {"if": [{"ref": "nextHasPassed"}, "passed", "completed"]}],
      [{"eq": [{"param": "moveOn"}, "NotApplicable"]},       "notApplicable"],
      [true, null]
    ]}
  },
  "actions": [
    {
      "type": "assign",
      "transforms": [
        {"path": ["aus", {"param": "auId"}, "hasCompleted"], "set": {"ref": "nextHasCompleted"}},
        {"path": ["aus", {"param": "auId"}, "hasPassed"], "set": {"ref": "nextHasPassed"}},
        {"path": ["aus", {"param": "auId"}, "hasFailed"], "set": {"ref": "nextHasFailed"}},
        {"path": ["aus", {"param": "auId"}, "method"], "set": {"ref": "method"}},
        {"path": ["aus", {"param": "auId"}, "satisfiedAt"], "set": {"ref": "timestamp"}},
        {"path": ["lastSatisfyingSessionId"], "set": {"ref": "sessionId"}}
      ]
    },
    {
      "guard": {"not": {"isNull": {"ref": "score"}}},
      "actions": [{
        "type": "assign",
        "transforms": [
          {"path": ["aus", {"param": "auId"}, "score"], "set": {"object": {"scaled": {"ref": "score"}}}}
        ]
      }]
    },
    {
      "guard": {"and": [{"ref": "nextHasPassed"}, {"not": {"select": ["current", "hasPassed"]}}]},
      "actions": [{
        "type": "emit",
        "event": {
          "type": "EMIT_AU_PASSED",
          "registrationId": {"select": ["context", "registrationId"]},
          "actor": {"select": ["context", "actor"]},
          "auId": {"param": "auId"},
          "auTitle": {"ref": "auTitle"},
          "sessionId": {"ref": "sessionId"},
          "timestamp": {"ref": "timestamp"},
          "score": {"ref": "score"}
        }
      }]
    },
    {
      "type": "emit",
      "event": {
        "type": "EMIT_SATISFIED_AU",
        "registrationId": {"select": ["context", "registrationId"]},
        "actor": {"select": ["context", "actor"]},
        "auId": {"param": "auId"},
        "auTitle": {"ref": "auTitle"},
        "sessionId": {"ref": "sessionId"},
        "timestamp": {"ref": "timestamp"}
      }
    }
  ]
}
```

Notes:
- `let` captures `current` before assigns mutate context — used in the guarded emit check
- Conditional score assign uses a guarded block within enqueueActions
- `object` operator constructs `{ scaled: score }` from computed value
- `coalesce` handles `??` defaults throughout

---

### `updateAU` (params: `{ auId, moveOn, masteryScore, verbId }`)

Same building blocks as `satisfyAU` but no method/satisfiedAt, and also emits EMIT_AU_FAILED:

```json
{
  "type": "enqueueActions",
  "let": {
    "current": {"select": ["context", "aus", {"param": "auId"}]},
    "score": {"select": ["event", "score"]},
    "sessionId": {"coalesce": [{"select": ["event", "sessionId"]}, {"fn": "uuid"}]},
    "timestamp": {"coalesce": [{"select": ["event", "timestamp"]}, {"fn": "now"}]},
    "auTitle": {"coalesce": [
      {"select": ["context", "metadata", "auTitles", {"param": "auId"}]},
      {"param": "auId"}
    ]},

    "nextHasCompleted": {"or": [
      {"select": ["current", "hasCompleted"]},
      {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/completed"]}
    ]},
    "nextHasPassed": {"or": [
      {"select": ["current", "hasPassed"]},
      {"and": [
        {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/passed"]},
        {"if": [{"isNull": {"ref": "score"}}, true, {"gte": [{"ref": "score"}, {"param": "masteryScore"}]}]}
      ]}
    ]},
    "nextHasFailed": {"or": [
      {"select": ["current", "hasFailed"]},
      {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/failed"]}
    ]}
  },
  "actions": [
    {
      "type": "assign",
      "transforms": [
        {"path": ["aus", {"param": "auId"}, "hasCompleted"], "set": {"ref": "nextHasCompleted"}},
        {"path": ["aus", {"param": "auId"}, "hasPassed"], "set": {"ref": "nextHasPassed"}},
        {"path": ["aus", {"param": "auId"}, "hasFailed"], "set": {"ref": "nextHasFailed"}}
      ]
    },
    {
      "guard": {"not": {"isNull": {"ref": "score"}}},
      "actions": [{
        "type": "assign",
        "transforms": [
          {"path": ["aus", {"param": "auId"}, "score"], "set": {"object": {"scaled": {"ref": "score"}}}}
        ]
      }]
    },
    {
      "guard": {"and": [{"ref": "nextHasPassed"}, {"not": {"select": ["current", "hasPassed"]}}]},
      "actions": [{
        "type": "emit",
        "event": {
          "type": "EMIT_AU_PASSED",
          "registrationId": {"select": ["context", "registrationId"]},
          "actor": {"select": ["context", "actor"]},
          "auId": {"param": "auId"},
          "auTitle": {"ref": "auTitle"},
          "sessionId": {"ref": "sessionId"},
          "timestamp": {"ref": "timestamp"},
          "score": {"ref": "score"}
        }
      }]
    },
    {
      "guard": {"and": [{"ref": "nextHasFailed"}, {"not": {"select": ["current", "hasFailed"]}}]},
      "actions": [{
        "type": "emit",
        "event": {
          "type": "EMIT_AU_FAILED",
          "registrationId": {"select": ["context", "registrationId"]},
          "actor": {"select": ["context", "actor"]},
          "auId": {"param": "auId"},
          "auTitle": {"ref": "auTitle"},
          "sessionId": {"ref": "sessionId"},
          "timestamp": {"ref": "timestamp"},
          "score": {"ref": "score"}
        }
      }]
    }
  ]
}
```

---

### `waiveAU` (params: `{ auId }`)

```json
{
  "type": "enqueueActions",
  "let": {
    "sessionId": {"fn": "uuid"},
    "timestamp": {"coalesce": [{"select": ["event", "timestamp"]}, {"fn": "now"}]},
    "reason": {"coalesce": [{"select": ["event", "reason"]}, "Administrative"]},
    "auTitle": {"coalesce": [
      {"select": ["context", "metadata", "auTitles", {"param": "auId"}]},
      {"param": "auId"}
    ]}
  },
  "actions": [
    {
      "type": "assign",
      "transforms": [
        {"path": ["aus", {"param": "auId"}, "hasWaived"], "set": true},
        {"path": ["aus", {"param": "auId"}, "method"], "set": "waived"},
        {"path": ["aus", {"param": "auId"}, "satisfiedAt"], "set": {"ref": "timestamp"}},
        {"path": ["lastSatisfyingSessionId"], "set": {"ref": "sessionId"}}
      ]
    },
    {
      "type": "emit",
      "event": {
        "type": "EMIT_WAIVED",
        "registrationId": {"select": ["context", "registrationId"]},
        "actor": {"select": ["context", "actor"]},
        "auId": {"param": "auId"},
        "auTitle": {"ref": "auTitle"},
        "sessionId": {"ref": "sessionId"},
        "timestamp": {"ref": "timestamp"},
        "reason": {"ref": "reason"}
      }
    },
    {
      "type": "emit",
      "event": {
        "type": "EMIT_SATISFIED_AU",
        "registrationId": {"select": ["context", "registrationId"]},
        "actor": {"select": ["context", "actor"]},
        "auId": {"param": "auId"},
        "auTitle": {"ref": "auTitle"},
        "sessionId": {"ref": "sessionId"},
        "timestamp": {"ref": "timestamp"}
      }
    }
  ]
}
```

Clean.

---

### `requestSignoff` (params: `{ auId, moveOn, masteryScore, verbId }`)

```json
{
  "type": "enqueueActions",
  "let": {
    "current": {"select": ["context", "aus", {"param": "auId"}]},
    "score": {"select": ["event", "score"]},
    "sessionId": {"coalesce": [{"select": ["event", "sessionId"]}, {"fn": "uuid"}]},
    "timestamp": {"coalesce": [{"select": ["event", "timestamp"]}, {"fn": "now"}]},
    "auTitle": {"coalesce": [
      {"select": ["context", "metadata", "auTitles", {"param": "auId"}]},
      {"param": "auId"}
    ]},

    "nextHasCompleted": {"or": [
      {"select": ["current", "hasCompleted"]},
      {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/completed"]}
    ]},
    "nextHasPassed": {"or": [
      {"select": ["current", "hasPassed"]},
      {"and": [
        {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/passed"]},
        {"if": [{"isNull": {"ref": "score"}}, true, {"gte": [{"ref": "score"}, {"param": "masteryScore"}]}]}
      ]}
    ]},
    "nextHasFailed": {"or": [
      {"select": ["current", "hasFailed"]},
      {"eq": [{"param": "verbId"}, "http://adlnet.gov/expapi/verbs/failed"]}
    ]},

    "method": {"cond": [
      [{"eq": [{"param": "moveOn"}, "Completed"]},          "completed"],
      [{"eq": [{"param": "moveOn"}, "Passed"]},              "passed"],
      [{"eq": [{"param": "moveOn"}, "CompletedAndPassed"]},  "completedAndPassed"],
      [{"eq": [{"param": "moveOn"}, "CompletedOrPassed"]},   {"if": [{"ref": "nextHasPassed"}, "passed", "completed"]}],
      [{"eq": [{"param": "moveOn"}, "NotApplicable"]},       "notApplicable"],
      [true, null]
    ]}
  },
  "actions": [
    {
      "type": "assign",
      "transforms": [
        {"path": ["aus", {"param": "auId"}, "hasCompleted"], "set": {"ref": "nextHasCompleted"}},
        {"path": ["aus", {"param": "auId"}, "hasPassed"], "set": {"ref": "nextHasPassed"}},
        {"path": ["aus", {"param": "auId"}, "hasFailed"], "set": {"ref": "nextHasFailed"}},
        {"path": ["aus", {"param": "auId"}, "method"], "set": {"ref": "method"}},
        {"path": ["lastSatisfyingSessionId"], "set": {"ref": "sessionId"}}
      ]
    },
    {
      "guard": {"not": {"isNull": {"ref": "score"}}},
      "actions": [{
        "type": "assign",
        "transforms": [
          {"path": ["aus", {"param": "auId"}, "score"], "set": {"object": {"scaled": {"ref": "score"}}}}
        ]
      }]
    },
    {
      "type": "emit",
      "event": {
        "type": "ASSESSMENT_PENDING_SIGNOFF",
        "registrationId": {"select": ["context", "registrationId"]},
        "actor": {"select": ["context", "actor"]},
        "auId": {"param": "auId"},
        "auTitle": {"ref": "auTitle"},
        "sessionId": {"ref": "sessionId"},
        "timestamp": {"ref": "timestamp"},
        "score": {"ref": "score"}
      }
    }
  ]
}
```

---

### `approveAssessment` (params: `{ auId }`)

```json
{
  "type": "enqueueActions",
  "let": {
    "timestamp": {"coalesce": [{"select": ["event", "timestamp"]}, {"fn": "now"}]},
    "sessionId": {"coalesce": [{"select": ["context", "lastSatisfyingSessionId"]}, {"fn": "uuid"}]},
    "auTitle": {"coalesce": [
      {"select": ["context", "metadata", "auTitles", {"param": "auId"}]},
      {"param": "auId"}
    ]}
  },
  "actions": [
    {
      "type": "assign",
      "transforms": [
        {"path": ["aus", {"param": "auId"}, "satisfiedAt"], "set": {"ref": "timestamp"}},
        {"path": ["lastSatisfyingSessionId"], "set": {"ref": "sessionId"}}
      ]
    },
    {
      "type": "emit",
      "event": {
        "type": "EMIT_SATISFIED_AU",
        "registrationId": {"select": ["context", "registrationId"]},
        "actor": {"select": ["context", "actor"]},
        "auId": {"param": "auId"},
        "auTitle": {"ref": "auTitle"},
        "sessionId": {"ref": "sessionId"},
        "timestamp": {"ref": "timestamp"}
      }
    }
  ]
}
```

---

### `returnAssessment` (params: `{ auId }`)

```json
{
  "type": "enqueueActions",
  "let": {
    "timestamp": {"coalesce": [{"select": ["event", "timestamp"]}, {"fn": "now"}]},
    "supervisorId": {"coalesce": [{"select": ["event", "supervisorId"]}, "unknown"]},
    "reason": {"select": ["event", "reason"]},
    "auTitle": {"coalesce": [
      {"select": ["context", "metadata", "auTitles", {"param": "auId"}]},
      {"param": "auId"}
    ]}
  },
  "actions": [
    {
      "type": "assign",
      "transforms": [
        {"path": ["aus", {"param": "auId"}, "hasCompleted"], "set": false},
        {"path": ["aus", {"param": "auId"}, "hasPassed"], "set": false},
        {"path": ["aus", {"param": "auId"}, "hasFailed"], "set": false},
        {"path": ["aus", {"param": "auId"}, "method"], "set": null},
        {"path": ["aus", {"param": "auId"}, "score"], "set": null}
      ]
    },
    {
      "type": "emit",
      "event": {
        "type": "ASSESSMENT_RETURNED",
        "registrationId": {"select": ["context", "registrationId"]},
        "actor": {"select": ["context", "actor"]},
        "auId": {"param": "auId"},
        "auTitle": {"ref": "auTitle"},
        "supervisorId": {"ref": "supervisorId"},
        "reason": {"ref": "reason"},
        "timestamp": {"ref": "timestamp"}
      }
    }
  ]
}
```

---

### `satisfyNotApplicableAU` (params: `{ auId }`)

```json
{
  "type": "enqueueActions",
  "let": {
    "sessionId": {"fn": "uuid"},
    "timestamp": {"fn": "now"},
    "auTitle": {"coalesce": [
      {"select": ["context", "metadata", "auTitles", {"param": "auId"}]},
      {"param": "auId"}
    ]}
  },
  "actions": [
    {
      "type": "assign",
      "transforms": [
        {"path": ["aus", {"param": "auId"}, "method"], "set": "notApplicable"},
        {"path": ["aus", {"param": "auId"}, "satisfiedAt"], "set": {"ref": "timestamp"}},
        {"path": ["lastSatisfyingSessionId"], "set": {"ref": "sessionId"}}
      ]
    },
    {
      "type": "emit",
      "event": {
        "type": "EMIT_SATISFIED_AU",
        "registrationId": {"select": ["context", "registrationId"]},
        "actor": {"select": ["context", "actor"]},
        "auId": {"param": "auId"},
        "auTitle": {"ref": "auTitle"},
        "sessionId": {"ref": "sessionId"},
        "timestamp": {"ref": "timestamp"}
      }
    }
  ]
}
```

---

### `satisfyBlock` (params: `{ blockId }`)

```json
{
  "type": "enqueueActions",
  "let": {
    "timestamp": {"fn": "now"},
    "blockTitle": {"coalesce": [
      {"select": ["context", "metadata", "blockTitles", {"param": "blockId"}]},
      {"param": "blockId"}
    ]},
    "sessionId": {"coalesce": [
      {"select": ["context", "lastSatisfyingSessionId"]},
      {"fn": "uuid"}
    ]}
  },
  "actions": [
    {
      "guard": {"not": {"in": [{"param": "blockId"}, {"select": ["context", "satisfiedBlocks"]}]}},
      "actions": [
        {
          "type": "assign",
          "transforms": [
            {"path": ["satisfiedBlocks"], "append": {"param": "blockId"}}
          ]
        },
        {
          "type": "emit",
          "event": {
            "type": "EMIT_SATISFIED_BLOCK",
            "registrationId": {"select": ["context", "registrationId"]},
            "actor": {"select": ["context", "actor"]},
            "blockId": {"param": "blockId"},
            "blockTitle": {"ref": "blockTitle"},
            "sessionId": {"ref": "sessionId"},
            "timestamp": {"ref": "timestamp"}
          }
        }
      ]
    }
  ]
}
```

---

### `satisfyCourse` (no params)

```json
{
  "type": "enqueueActions",
  "let": {
    "timestamp": {"fn": "now"},
    "sessionId": {"coalesce": [
      {"select": ["context", "lastSatisfyingSessionId"]},
      {"fn": "uuid"}
    ]}
  },
  "actions": [
    {
      "type": "assign",
      "transforms": [
        {"path": ["courseSatisfied"], "set": true},
        {"path": ["courseSatisfiedAt"], "set": {"ref": "timestamp"}}
      ]
    },
    {
      "type": "emit",
      "event": {
        "type": "EMIT_SATISFIED_COURSE",
        "registrationId": {"select": ["context", "registrationId"]},
        "actor": {"select": ["context", "actor"]},
        "courseId": {"select": ["context", "metadata", "courseId"]},
        "courseTitle": {"select": ["context", "metadata", "courseTitle"]},
        "sessionId": {"ref": "sessionId"},
        "timestamp": {"ref": "timestamp"}
      }
    }
  ]
}
```

---

### `handleSessionLaunch` (no params)

```json
{
  "type": "enqueueActions",
  "actions": [
    {
      "type": "emit",
      "event": {
        "type": "SESSIONS_ABANDONED",
        "registrationId": {"select": ["context", "registrationId"]},
        "actor": {"select": ["context", "actor"]},
        "timestamp": {"select": ["event", "timestamp"]},
        "sessions": {"entries": ["context", "sessions", {"where": {"in": ["state", ["launched", "active"]]}}]}
      }
    },
    {
      "type": "assign",
      "transforms": [
        {
          "path": ["sessions", {"where": {"in": ["state", ["launched", "active"]]}}, "state"],
          "set": "abandoned"
        },
        {
          "path": ["sessions", {"ref": "event.sessionId"}],
          "set": {
            "state": "launched",
            "auId": {"select": ["event", "auId"]},
            "launchMode": {"select": ["event", "launchMode"]},
            "launchedAt": {"select": ["event", "timestamp"]},
            "fetchToken": {"select": ["event", "fetchToken"]}
          }
        }
      ]
    },
    {
      "type": "emit",
      "event": {
        "type": "SESSION_LAUNCHED",
        "registrationId": {"select": ["context", "registrationId"]},
        "actor": {"select": ["context", "actor"]},
        "sessionId": {"select": ["event", "sessionId"]},
        "auId": {"select": ["event", "auId"]},
        "launchMode": {"select": ["event", "launchMode"]},
        "fetchToken": {"select": ["event", "fetchToken"]},
        "launchedAt": {"select": ["event", "timestamp"]}
      }
    }
  ]
}
```

Notes:
- Batch emit comes **before** the assign — `where` navigator captures the open sessions while they still have `launched`/`active` state
- Effect processor receives the full collection and fans out to per-session effects in plain TypeScript (computing duration per session where it's trivial)
- The `where` navigator is reused in both positions — zero new primitives needed

---

### `handleFetchTokenRetrieved` (no params)

```json
{
  "type": "enqueueActions",
  "let": {
    "session": {"select": ["context", "sessions", {"ref": "event.sessionId"}]}
  },
  "actions": [
    {
      "guard": {"and": [
        {"not": {"isNull": {"ref": "session"}}},
        {"not": {"isNull": {"select": ["session", "fetchToken"]}}},
        {"isNull": {"select": ["session", "fetchTokenRetrievedAt"]}}
      ]},
      "actions": [
        {
          "type": "assign",
          "transforms": [
            {"path": ["sessions", {"ref": "event.sessionId"}, "fetchTokenRetrievedAt"],
             "set": {"select": ["event", "timestamp"]}}
          ]
        },
        {
          "type": "emit",
          "event": {
            "type": "SESSION_TOKEN_RETRIEVED",
            "sessionId": {"select": ["event", "sessionId"]},
            "auId": {"select": ["session", "auId"]},
            "registrationId": {"select": ["context", "registrationId"]},
            "timestamp": {"select": ["event", "timestamp"]}
          }
        }
      ]
    }
  ]
}
```

---

### `handleInitialized` (no params)

```json
{
  "type": "enqueueActions",
  "let": {
    "session": {"select": ["context", "sessions", {"ref": "event.sessionId"}]}
  },
  "actions": [
    {
      "guard": {"not": {"isNull": {"ref": "session"}}},
      "actions": [
        {
          "type": "assign",
          "transforms": [
            {"path": ["sessions", {"ref": "event.sessionId"}, "state"], "set": "active"},
            {"path": ["sessions", {"ref": "event.sessionId"}, "initializedAt"],
             "set": {"select": ["event", "timestamp"]}}
          ]
        },
        {
          "type": "emit",
          "event": {
            "type": "SESSION_INITIALIZED",
            "sessionId": {"select": ["event", "sessionId"]},
            "auId": {"select": ["session", "auId"]},
            "registrationId": {"select": ["context", "registrationId"]},
            "timestamp": {"select": ["event", "timestamp"]}
          }
        }
      ]
    }
  ]
}
```

---

### `handleTerminated` (no params)

```json
{
  "type": "enqueueActions",
  "let": {
    "session": {"select": ["context", "sessions", {"ref": "event.sessionId"}]},
    "auTitle": {"coalesce": [
      {"select": ["context", "metadata", "auTitles", {"select": ["session", "auId"]}]},
      {"select": ["session", "auId"]}
    ]}
  },
  "actions": [
    {
      "guard": {"not": {"isNull": {"ref": "session"}}},
      "actions": [
        {
          "type": "assign",
          "transforms": [
            {"path": ["sessions", {"ref": "event.sessionId"}, "state"], "set": "terminated"},
            {"path": ["sessions", {"ref": "event.sessionId"}, "terminatedAt"],
             "set": {"select": ["event", "timestamp"]}}
          ]
        },
        {
          "type": "emit",
          "event": {
            "type": "SESSION_TERMINATED",
            "registrationId": {"select": ["context", "registrationId"]},
            "actor": {"select": ["context", "actor"]},
            "sessionId": {"select": ["event", "sessionId"]},
            "auId": {"select": ["session", "auId"]},
            "auTitle": {"ref": "auTitle"},
            "timestamp": {"select": ["event", "timestamp"]}
          }
        }
      ]
    }
  ]
}
```

---

### `handleSessionTimeout` (no params)

```json
{
  "type": "enqueueActions",
  "let": {
    "session": {"select": ["context", "sessions", {"ref": "event.sessionId"}]},
    "auTitle": {"coalesce": [
      {"select": ["context", "metadata", "auTitles", {"select": ["session", "auId"]}]},
      {"select": ["session", "auId"]}
    ]}
  },
  "actions": [
    {
      "guard": {"and": [
        {"not": {"isNull": {"ref": "session"}}},
        {"neq": [{"select": ["session", "state"]}, "terminated"]}
      ]},
      "actions": [
        {
          "type": "assign",
          "transforms": [
            {"path": ["sessions", {"ref": "event.sessionId"}, "state"], "set": "abandoned"}
          ]
        },
        {
          "type": "emit",
          "event": {
            "type": "SESSION_ABANDONED",
            "sessionId": {"select": ["event", "sessionId"]},
            "auId": {"select": ["session", "auId"]},
            "registrationId": {"select": ["context", "registrationId"]},
            "timestamp": {"select": ["event", "timestamp"]}
          }
        },
        {
          "type": "emit",
          "event": {
            "type": "EMIT_ABANDONED",
            "registrationId": {"select": ["context", "registrationId"]},
            "actor": {"select": ["context", "actor"]},
            "auId": {"select": ["session", "auId"]},
            "auTitle": {"ref": "auTitle"},
            "sessionId": {"select": ["event", "sessionId"]},
            "timestamp": {"select": ["event", "timestamp"]},
            "duration": {"if": [
              {"not": {"isNull": {"select": ["session", "launchedAt"]}}},
              {"fn": "iso8601Duration", "args": [
                {"select": ["session", "launchedAt"]},
                {"select": ["event", "timestamp"]}
              ]},
              "PT0S"
            ]}
          }
        }
      ]
    }
  ]
}
```

---

### `handleAnswered` (no params)

```json
{
  "type": "enqueueActions",
  "let": {
    "session": {"select": ["context", "sessions", {"ref": "event.sessionId"}]}
  },
  "actions": [
    {
      "guard": {"not": {"isNull": {"ref": "session"}}},
      "actions": [{
        "type": "emit",
        "event": {
          "type": "EMIT_QUESTION_ANSWERED",
          "registrationId": {"select": ["context", "registrationId"]},
          "actor": {"select": ["context", "actor"]},
          "auId": {"select": ["session", "auId"]},
          "sessionId": {"select": ["event", "sessionId"]},
          "timestamp": {"select": ["event", "timestamp"]},
          "score": {"select": ["event", "score"]},
          "success": {"select": ["event", "success"]},
          "objectiveId": {"select": ["event", "objectiveId"]},
          "response": {"select": ["event", "response"]},
          "sourceStatementId": {"select": ["event", "sourceStatementId"]}
        }
      }]
    }
  ]
}
```

---

## Gaps Summary

### New operators needed (all trivial to implement)

| Operator | Purpose | Example |
|----------|---------|---------|
| `coalesce` | First non-null value (`??` in JS) | `{"coalesce": [expr, default]}` |
| `isNull` | Check if null/undefined | `{"isNull": expr}` |
| `object` | Construct literal object | `{"object": {"key": expr}}` |
| `fn` with `args` | Parameterized builtins | `{"fn": "iso8601Duration", "args": [start, end]}` |

### Registered builtins

| Builtin | Status |
|---------|--------|
| `uuid` | Already in plan |
| `now` | Already in plan |
| `iso8601Duration(start, end)` | New — domain-specific |

### Shared computation duplication

The `computeNextFlags` pattern (3 let bindings) appears in `verbSatisfiesAU`, `verbUpdatesAU`,
`satisfyAU`, `updateAU`, and `requestSignoff`. Each instance is ~10 lines of JSON. With the
decomposed functions this is tolerable — a `computations` section would be a nice-to-have, not
a blocker.

## Verdict

The full registration machine (all 4 guards, all 15 actions) is expressible as data expressions
with existing primitives + 4 trivial new operators. No open design questions remain.
`handleSessionLaunch` uses batch emit with the `where` navigator (already needed for the assign)
to collect abandoned sessions — the effect processor fans out in plain TypeScript.
