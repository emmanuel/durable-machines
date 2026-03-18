import { describe, it, expect } from "vitest";
import { compileGuard, compileAction } from "../../src/compile-actions.js";
import { evaluateActions } from "../../src/actions.js";
import { createScope } from "../../src/types.js";
import { createBuiltinRegistry } from "../../src/builtins.js";
import type { ActionDef, EnqueueActionsDef, Scope } from "../../src/types.js";

// ─── compileGuard ────────────────────────────────────────────────────────────

describe("compileGuard", () => {
  it("returns true for truthy expression", () => {
    const guard = compileGuard({ eq: [1, 1] });
    expect(guard(createScope({ context: {} }))).toBe(true);
  });

  it("returns false for falsy expression", () => {
    const guard = compileGuard({ eq: [1, 2] });
    expect(guard(createScope({ context: {} }))).toBe(false);
  });

  it("coerces non-boolean to boolean", () => {
    const guard = compileGuard({ select: ["context", "name"] });
    expect(guard(createScope({ context: { name: "Alice" } }))).toBe(true);
    expect(guard(createScope({ context: { name: "" } }))).toBe(false);
  });

  it("handles let + body (verbSatisfiesAU pattern)", () => {
    const guard = compileGuard({
      let: [
        {
          current: { select: ["context", "aus", { param: "auId" }] },
          nextHasCompleted: { or: [
            { select: ["current", "hasCompleted"] },
            { eq: [{ param: "verbId" }, "http://adlnet.gov/expapi/verbs/completed"] },
          ]},
        },
        { and: [
          { eq: [{ select: ["event", "auId"] }, { param: "auId" }] },
          { ref: "nextHasCompleted" },
        ]},
      ],
    });

    const scope = createScope({
      context: { aus: { "au-1": { hasCompleted: false } } },
      event: { auId: "au-1" },
      params: { auId: "au-1", verbId: "http://adlnet.gov/expapi/verbs/completed" },
    });
    expect(guard(scope)).toBe(true);
  });
});

// ─── compileAction ───────────────────────────────────────────────────────────

describe("compileAction", () => {
  const testBuiltins = createBuiltinRegistry({
    uuid: () => "test-uuid",
    now: () => 1000,
  });

  it("assign — applies transforms", () => {
    const action: ActionDef = {
      type: "assign",
      transforms: [{ path: ["x"], set: 42 }],
    };
    const compiled = compileAction(action, testBuiltins);
    const results = compiled(createScope({ context: { x: 0 } }));
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("assign");
    expect((results[0] as any).context.x).toBe(42);
  });

  it("emit — evaluates event payload", () => {
    const action: ActionDef = {
      type: "emit",
      event: { type: "DONE", id: { select: ["context", "id"] } },
    };
    const compiled = compileAction(action, testBuiltins);
    const results = compiled(createScope({ context: { id: "abc" } }));
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ type: "emit", event: { type: "DONE", id: "abc" } });
  });

  it("raise — evaluates event payload + delay", () => {
    const action: ActionDef = {
      type: "raise",
      event: { type: "RETRY" },
      delay: 5000,
      id: "retry-1",
    };
    const compiled = compileAction(action, testBuiltins);
    const results = compiled(createScope({ context: {} }));
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ type: "raise", event: { type: "RETRY" }, delay: 5000, id: "retry-1" });
  });

  it("enqueueActions — let bindings + guarded blocks", () => {
    const action: EnqueueActionsDef = {
      type: "enqueueActions",
      let: { ts: { fn: "now" } },
      actions: [
        { type: "assign", transforms: [{ path: ["updatedAt"], set: { ref: "ts" } }] },
        {
          guard: { gt: [{ ref: "ts" }, 0] },
          actions: [{ type: "emit", event: { type: "UPDATED", ts: { ref: "ts" } } }],
        },
      ],
    };
    const compiled = compileAction(action, testBuiltins);
    const results = compiled(createScope({ context: { updatedAt: 0 } }));
    expect(results).toHaveLength(2);
    expect((results[0] as any).context.updatedAt).toBe(1000);
    expect((results[1] as any).event).toEqual({ type: "UPDATED", ts: 1000 });
  });

  it("context chains between sequential assigns", () => {
    const action: EnqueueActionsDef = {
      type: "enqueueActions",
      actions: [
        { type: "assign", transforms: [{ path: ["a"], set: 1 }] },
        { type: "assign", transforms: [{ path: ["b"], set: 2 }] },
      ],
    };
    const compiled = compileAction(action, testBuiltins);
    const results = compiled(createScope({ context: { a: 0, b: 0 } }));
    const ctx1 = (results[1] as any).context;
    expect(ctx1.a).toBe(1);
    expect(ctx1.b).toBe(2);
  });

  it("equivalence with evaluateActions", () => {
    const action: EnqueueActionsDef = {
      type: "enqueueActions",
      let: { x: { add: [{ select: ["context", "n"] }, 1] } },
      actions: [
        { type: "assign", transforms: [{ path: ["n"], set: { ref: "x" } }] },
        { type: "emit", event: { type: "INC", n: { ref: "x" } } },
      ],
    };
    const scope = createScope({ context: { n: 5 } });
    const compiledResults = compileAction(action, testBuiltins)(scope);
    const interpretedResults = evaluateActions(action, scope, testBuiltins);
    expect(compiledResults).toEqual(interpretedResults);
  });
});
