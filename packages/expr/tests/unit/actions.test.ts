import { describe, it, expect } from "vitest";
import { evaluateActions } from "../../src/actions.js";
import { createScope } from "../../src/types.js";
import { defaultBuiltins } from "../../src/builtins.js";

describe("evaluateActions — assign", () => {
  it("applies transforms and returns new context", () => {
    const scope = createScope({
      context: { x: 1, y: 2 },
      params: {},
    });
    const results = evaluateActions({
      type: "assign",
      transforms: [
        { path: ["x"], set: 10 },
        { path: ["y"], set: 20 },
      ],
    }, scope, defaultBuiltins);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ type: "assign", context: { x: 10, y: 20 } });
  });

  it("assign with let bindings", () => {
    const scope = createScope({
      context: { aus: { "au-1": { hasPassed: false } } },
      params: { auId: "au-1" },
      event: { score: 90 },
    });
    const results = evaluateActions({
      type: "assign",
      let: { score: { select: ["event", "score"] } },
      transforms: [
        { path: ["aus", { param: "auId" }, "hasPassed"], set: true },
      ],
    }, scope, defaultBuiltins);
    expect(results[0].type).toBe("assign");
    expect((results[0] as any).context.aus["au-1"].hasPassed).toBe(true);
  });

  it("does not mutate original context", () => {
    const scope = createScope({ context: { x: 1 } });
    const results = evaluateActions({
      type: "assign",
      transforms: [{ path: ["x"], set: 99 }],
    }, scope, defaultBuiltins);
    expect((results[0] as any).context.x).toBe(99);
    expect(scope.context.x).toBe(1); // original unchanged
  });
});

describe("evaluateActions — emit", () => {
  it("evaluates event payload expressions", () => {
    const scope = createScope({
      context: { registrationId: "reg-1" },
      params: { auId: "au-1" },
    });
    const results = evaluateActions({
      type: "emit",
      event: {
        type: "EMIT_SATISFIED_AU",
        registrationId: { select: ["context", "registrationId"] },
        auId: { param: "auId" },
      },
    }, scope, defaultBuiltins);
    expect(results).toEqual([{
      type: "emit",
      event: {
        type: "EMIT_SATISFIED_AU",
        registrationId: "reg-1",
        auId: "au-1",
      },
    }]);
  });

  it("evaluates nested expression values", () => {
    const scope = createScope({
      context: { x: 10 },
    });
    const results = evaluateActions({
      type: "emit",
      event: {
        type: "TEST",
        doubled: { add: [{ select: ["context", "x"] }, { select: ["context", "x"] }] },
      },
    }, scope, defaultBuiltins);
    expect((results[0] as any).event.doubled).toBe(20);
  });
});

describe("evaluateActions — raise", () => {
  it("evaluates raise event", () => {
    const scope = createScope({ context: {} });
    const results = evaluateActions({
      type: "raise",
      event: { type: "TIMEOUT" },
      delay: 5000,
      id: "timer-1",
    }, scope, defaultBuiltins);
    expect(results).toEqual([{
      type: "raise",
      event: { type: "TIMEOUT" },
      delay: 5000,
      id: "timer-1",
    }]);
  });

  it("omits delay and id when not specified", () => {
    const scope = createScope({ context: {} });
    const results = evaluateActions({
      type: "raise",
      event: { type: "NEXT" },
    }, scope, defaultBuiltins);
    expect(results[0]).toEqual({
      type: "raise",
      event: { type: "NEXT" },
    });
  });

  it("evaluates delay expression", () => {
    const scope = createScope({ context: {}, params: { timeout: 3000 } });
    const results = evaluateActions({
      type: "raise",
      event: { type: "TIMEOUT" },
      delay: { param: "timeout" },
    }, scope, defaultBuiltins);
    expect((results[0] as any).delay).toBe(3000);
  });
});

describe("evaluateActions — enqueueActions", () => {
  it("plain actions always execute", () => {
    const scope = createScope({ context: { x: 1 } });
    const results = evaluateActions({
      type: "enqueueActions",
      actions: [
        { type: "assign", transforms: [{ path: ["x"], set: 2 }] },
        { type: "emit", event: { type: "DONE" } },
      ],
    }, scope, defaultBuiltins);
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe("assign");
    expect(results[1]).toEqual({ type: "emit", event: { type: "DONE" } });
  });

  it("guarded block: executes when guard is true", () => {
    const scope = createScope({ context: { flag: true } });
    const results = evaluateActions({
      type: "enqueueActions",
      actions: [
        { guard: { select: ["context", "flag"] }, actions: [
          { type: "emit", event: { type: "FLAG_ON" } },
        ]},
      ],
    }, scope, defaultBuiltins);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ type: "emit", event: { type: "FLAG_ON" } });
  });

  it("guarded block: skipped when guard is false", () => {
    const scope = createScope({ context: { flag: false } });
    const results = evaluateActions({
      type: "enqueueActions",
      actions: [
        { guard: { select: ["context", "flag"] }, actions: [
          { type: "emit", event: { type: "FLAG_ON" } },
        ]},
      ],
    }, scope, defaultBuiltins);
    expect(results).toHaveLength(0);
  });

  it("let bindings scope across all entries", () => {
    const scope = createScope({
      context: { aus: { "au-1": { hasPassed: false } } },
      params: { auId: "au-1" },
    });
    const results = evaluateActions({
      type: "enqueueActions",
      let: {
        current: { select: ["context", "aus", { param: "auId" }] },
      },
      actions: [
        { type: "assign", transforms: [
          { path: ["aus", { param: "auId" }, "hasPassed"], set: true },
        ]},
        {
          guard: { and: [true, { not: { select: ["current", "hasPassed"] } }] },
          actions: [
            { type: "emit", event: { type: "EMIT_AU_PASSED", auId: { param: "auId" } } },
          ],
        },
      ],
    }, scope, defaultBuiltins);
    // assign + emit (guard passed because current.hasPassed was false at binding time)
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe("assign");
    expect(results[1]).toEqual({ type: "emit", event: { type: "EMIT_AU_PASSED", auId: "au-1" } });
  });

  it("all guarded blocks are evaluated (not first-match)", () => {
    const scope = createScope({ context: {} });
    const results = evaluateActions({
      type: "enqueueActions",
      actions: [
        { guard: true, actions: [{ type: "emit", event: { type: "A" } }] },
        { guard: true, actions: [{ type: "emit", event: { type: "B" } }] },
      ],
    }, scope, defaultBuiltins);
    expect(results).toHaveLength(2); // both fire
  });

  it("nested enqueueActions", () => {
    const scope = createScope({ context: {} });
    const results = evaluateActions({
      type: "enqueueActions",
      actions: [
        { type: "enqueueActions", actions: [
          { type: "emit", event: { type: "INNER" } },
        ]},
        { type: "emit", event: { type: "OUTER" } },
      ],
    }, scope, defaultBuiltins);
    expect(results).toHaveLength(2);
    expect((results[0] as any).event.type).toBe("INNER");
    expect((results[1] as any).event.type).toBe("OUTER");
  });

  it("sequential assigns chain context (second sees first's changes)", () => {
    const action: import("../../src/types.js").EnqueueActionsDef = {
      type: "enqueueActions",
      actions: [
        {
          type: "assign",
          transforms: [{ path: ["a"], set: 1 }],
        },
        {
          type: "assign",
          transforms: [{ path: ["b"], set: 2 }],
        },
      ],
    };

    const scope = createScope({ context: { a: 0, b: 0 } });
    const results = evaluateActions(action, scope, defaultBuiltins);
    expect(results).toHaveLength(2);

    // Second assign should include first assign's changes
    const ctx1 = (results[1] as { type: "assign"; context: Record<string, unknown> }).context;
    expect(ctx1.a).toBe(1); // from first assign
    expect(ctx1.b).toBe(2); // from second assign
  });
});
