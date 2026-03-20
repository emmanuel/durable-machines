import { describe, it, expect } from "vitest";
import { selectPath } from "../../src/path.js";
import { applyTransforms } from "../../src/transforms.js";
import { createScope } from "../../src/types.js";
import { evaluate } from "../../src/evaluate.js";

describe("selectPath", () => {
  it("navigates static keys", () => {
    const scope = createScope({ context: { name: "Alice" } });
    expect(selectPath(["context", "name"], scope)).toBe("Alice");
  });

  it("navigates nested keys", () => {
    const scope = createScope({ context: { aus: { "au-1": { hasCompleted: true } } } });
    expect(selectPath(["context", "aus", "au-1", "hasCompleted"], scope)).toBe(true);
  });

  it("returns undefined for missing paths", () => {
    const scope = createScope({ context: {} });
    expect(selectPath(["context", "missing", "deep"], scope)).toBeUndefined();
  });

  it("navigates event fields", () => {
    const scope = createScope({ context: {}, event: { type: "PASSED", score: 85 } });
    expect(selectPath(["event", "type"], scope)).toBe("PASSED");
    expect(selectPath(["event", "score"], scope)).toBe(85);
  });

  it("navigates with dynamic param key", () => {
    const scope = createScope({
      context: { aus: { "au-1": { hasPassed: true } } },
      params: { auId: "au-1" },
    });
    expect(selectPath(["context", "aus", { param: "auId" }, "hasPassed"], scope)).toBe(true);
  });

  it("navigates with dynamic ref key", () => {
    const scope = createScope({ context: { items: { x: 42 } } });
    scope.bindings = { key: "x" };
    expect(selectPath(["context", "items", { ref: "key" }], scope)).toBe(42);
  });

  it("returns undefined for null intermediate", () => {
    const scope = createScope({ context: { x: null } });
    expect(selectPath(["context", "x", "y"], scope)).toBeUndefined();
  });

  it("resolves binding as root", () => {
    const scope = createScope({ context: {} });
    scope.bindings = { current: { hasPassed: true } };
    expect(selectPath(["current", "hasPassed"], scope)).toBe(true);
  });
});

describe("applyTransforms", () => {
  it("set: overwrites value at path", () => {
    const ctx = { x: 1 };
    const scope = createScope({ context: ctx });
    const result = applyTransforms(ctx, [
      { path: ["x"], set: 42 },
    ], scope);
    expect(result).toEqual({ x: 42 });
    expect(ctx.x).toBe(1); // original unchanged
  });

  it("set: nested path", () => {
    const ctx = { aus: { "au-1": { hasCompleted: false } } };
    const scope = createScope({ context: ctx });
    const result = applyTransforms(ctx, [
      { path: ["aus", "au-1", "hasCompleted"], set: true },
    ], scope);
    expect(result.aus["au-1"].hasCompleted).toBe(true);
  });

  it("set: with dynamic param key", () => {
    const ctx = { aus: { "au-1": { hasPassed: false } } };
    const scope = createScope({ context: ctx, params: { auId: "au-1" } });
    const result = applyTransforms(ctx, [
      { path: ["aus", { param: "auId" }, "hasPassed"], set: true },
    ], scope);
    expect(result.aus["au-1"].hasPassed).toBe(true);
  });

  it("set: value is an expression", () => {
    const ctx = { x: 0 };
    const scope = createScope({ context: ctx, event: { value: 99 } });
    const result = applyTransforms(ctx, [
      { path: ["x"], set: { select: ["event", "value"] } },
    ], scope);
    expect(result).toEqual({ x: 99 });
  });

  it("set: value is a ref expression", () => {
    const ctx = { x: 0 };
    const scope = createScope({ context: ctx });
    scope.bindings = { computed: 42 };
    const result = applyTransforms(ctx, [
      { path: ["x"], set: { ref: "computed" } },
    ], scope);
    expect(result).toEqual({ x: 42 });
  });

  it("append: adds to array", () => {
    const ctx = { items: ["a", "b"] };
    const scope = createScope({ context: ctx });
    const result = applyTransforms(ctx, [
      { path: ["items"], append: "c" },
    ], scope);
    expect(result.items).toEqual(["a", "b", "c"]);
  });

  it("remove: deletes key", () => {
    const ctx = { a: 1, b: 2 };
    const scope = createScope({ context: ctx });
    const result = applyTransforms(ctx, [
      { path: ["b"], remove: true },
    ], scope);
    expect(result).toEqual({ a: 1 });
  });

  it("multiple transforms in sequence", () => {
    const ctx = { aus: { "au-1": { hasCompleted: false, hasPassed: false } }, lastId: "" };
    const scope = createScope({ context: ctx, params: { auId: "au-1" } });
    const result = applyTransforms(ctx, [
      { path: ["aus", { param: "auId" }, "hasCompleted"], set: true },
      { path: ["aus", { param: "auId" }, "hasPassed"], set: true },
      { path: ["lastId"], set: "session-1" },
    ], scope);
    expect(result.aus["au-1"]).toEqual({ hasCompleted: true, hasPassed: true });
    expect(result.lastId).toBe("session-1");
  });

  it("set: creates intermediate objects if missing", () => {
    const ctx: Record<string, unknown> = {};
    const scope = createScope({ context: ctx });
    const result = applyTransforms(ctx, [
      { path: ["a", "b", "c"], set: 1 },
    ], scope);
    expect(result).toEqual({ a: { b: { c: 1 } } });
  });

  it("set: with dynamic ref key", () => {
    const ctx = { items: { x: 0 } };
    const scope = createScope({ context: ctx });
    scope.bindings = { key: "x" };
    const result = applyTransforms(ctx, [
      { path: ["items", { ref: "key" }], set: 99 },
    ], scope);
    expect(result.items).toEqual({ x: 99 });
  });
});

describe("selectPath — collection navigators", () => {
  it("where: filters object entries", () => {
    const sessions = {
      "s-1": { state: "launched", auId: "au-1" },
      "s-2": { state: "terminated", auId: "au-1" },
      "s-3": { state: "active", auId: "au-2" },
    };
    const scope = createScope({ context: { sessions } });
    const result = selectPath(
      ["context", "sessions", { where: { in: ["state", ["launched", "active"]] } }],
      scope,
    );
    expect(result).toEqual({
      "s-1": { state: "launched", auId: "au-1" },
      "s-3": { state: "active", auId: "au-2" },
    });
  });

  it("where: returns empty object when no matches", () => {
    const scope = createScope({ context: { items: { a: { x: 1 }, b: { x: 2 } } } });
    const result = selectPath(
      ["context", "items", { where: { eq: ["x", 99] } }],
      scope,
    );
    expect(result).toEqual({});
  });

  it("where: with eq predicate", () => {
    const scope = createScope({ context: { users: { u1: { role: "admin" }, u2: { role: "user" }, u3: { role: "admin" } } } });
    const result = selectPath(
      ["context", "users", { where: { eq: ["role", "admin"] } }],
      scope,
    );
    expect(result).toEqual({ u1: { role: "admin" }, u3: { role: "admin" } });
  });

  it("$.path sugar works inside where predicates", () => {
    const scope = createScope({
      context: {
        items: {
          a: { state: "active", value: 1 },
          b: { state: "done", value: 2 },
          c: { state: "active", value: 3 },
        },
      },
      event: { targetState: "active" },
    });
    // Use $.event.targetState as the comparison value inside a where predicate
    const result = evaluate(
      { select: ["context", "items", { where: { eq: ["state", "$.event.targetState"] } }] },
      scope,
    );
    expect(result).toEqual({
      a: { state: "active", value: 1 },
      c: { state: "active", value: 3 },
    });
  });
});

describe("applyTransforms — where navigator", () => {
  it("where: sets value on all matching entries", () => {
    const ctx = {
      sessions: {
        "s-1": { state: "launched" },
        "s-2": { state: "terminated" },
        "s-3": { state: "active" },
      },
    };
    const scope = createScope({ context: ctx });
    const result = applyTransforms(ctx, [
      { path: ["sessions", { where: { in: ["state", ["launched", "active"]] } }, "state"], set: "abandoned" },
    ], scope);
    expect(result.sessions["s-1"].state).toBe("abandoned");
    expect(result.sessions["s-2"].state).toBe("terminated"); // unchanged
    expect(result.sessions["s-3"].state).toBe("abandoned");
  });

  it("where: does not mutate original", () => {
    const ctx = {
      items: { a: { val: 1 }, b: { val: 2 } },
    };
    const scope = createScope({ context: ctx });
    const result = applyTransforms(ctx, [
      { path: ["items", { where: { eq: ["val", 1] } }, "val"], set: 99 },
    ], scope);
    expect(result.items.a.val).toBe(99);
    expect(result.items.b.val).toBe(2);
    expect(ctx.items.a.val).toBe(1); // original unchanged
  });
});

describe("selectPath — sigil sugar in where predicates", () => {
  it("%.param in where predicate first operand filters by param value", () => {
    const scope = createScope({
      context: {
        entries: {
          a: { type: "x", val: 1 },
          b: { type: "y", val: 2 },
        },
      },
      params: { filterType: "x" },
    });
    const result = selectPath(
      ["context", "entries", { where: { eq: ["%.filterType", { ref: "type" }] } }],
      scope,
    );
    expect(result).toEqual({ a: { type: "x", val: 1 } });
  });
});

describe("selectPath — sigil path steps", () => {
  it("%.param as path step in selectPath", () => {
    const scope = createScope({
      context: { aus: { "au-1": { score: 95 } } },
      params: { auId: "au-1" },
    });
    expect(selectPath(["context", "aus", "%.auId", "score"], scope)).toBe(95);
  });

  it("@.ref as path step in selectPath", () => {
    const scope = createScope({
      context: { sessions: { "s-1": { active: true } } },
    });
    scope.bindings.sid = "s-1";
    expect(selectPath(["context", "sessions", "@.sid", "active"], scope)).toBe(true);
  });
});
