import { describe, it, expect } from "vitest";
import { selectPath } from "../../src/path.js";
import { applyTransforms } from "../../src/transforms.js";
import { createScope } from "../../src/types.js";

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
