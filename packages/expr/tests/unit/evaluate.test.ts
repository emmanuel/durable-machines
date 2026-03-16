import { describe, it, expect } from "vitest";
import { evaluate } from "../../src/evaluate.js";
import { createScope } from "../../src/types.js";

describe("evaluate — literals", () => {
  const scope = createScope({ context: {} });
  it("returns strings as-is", () => expect(evaluate("hello", scope)).toBe("hello"));
  it("returns numbers as-is", () => expect(evaluate(42, scope)).toBe(42));
  it("returns booleans as-is", () => expect(evaluate(true, scope)).toBe(true));
  it("returns null as-is", () => expect(evaluate(null, scope)).toBeNull());
  it("returns undefined as-is", () => expect(evaluate(undefined, scope)).toBeUndefined());
});

describe("evaluate — select", () => {
  it("selects a context value", () => {
    const scope = createScope({ context: { total: 50 } });
    expect(evaluate({ select: ["context", "total"] }, scope)).toBe(50);
  });

  it("selects a nested value with dynamic param key", () => {
    const scope = createScope({
      context: { aus: { "au-1": { hasCompleted: true } } },
      params: { auId: "au-1" },
    });
    expect(evaluate({ select: ["context", "aus", { param: "auId" }, "hasCompleted"] }, scope)).toBe(true);
  });
});

describe("evaluate — comparisons", () => {
  const scope = createScope({ context: { x: 10, name: "Alice" } });

  it("eq: equal values", () => {
    expect(evaluate({ eq: [{ select: ["context", "x"] }, 10] }, scope)).toBe(true);
  });
  it("eq: unequal values", () => {
    expect(evaluate({ eq: [{ select: ["context", "x"] }, 20] }, scope)).toBe(false);
  });
  it("neq: unequal values", () => {
    expect(evaluate({ neq: [{ select: ["context", "x"] }, 20] }, scope)).toBe(true);
  });
  it("gt", () => {
    expect(evaluate({ gt: [{ select: ["context", "x"] }, 5] }, scope)).toBe(true);
    expect(evaluate({ gt: [{ select: ["context", "x"] }, 10] }, scope)).toBe(false);
  });
  it("lt", () => {
    expect(evaluate({ lt: [{ select: ["context", "x"] }, 20] }, scope)).toBe(true);
  });
  it("gte", () => {
    expect(evaluate({ gte: [{ select: ["context", "x"] }, 10] }, scope)).toBe(true);
    expect(evaluate({ gte: [{ select: ["context", "x"] }, 11] }, scope)).toBe(false);
  });
  it("lte", () => {
    expect(evaluate({ lte: [{ select: ["context", "x"] }, 10] }, scope)).toBe(true);
  });
});

describe("evaluate — logic", () => {
  const scope = createScope({ context: { a: true, b: false, x: 10 } });

  it("and: all true", () => {
    expect(evaluate({ and: [true, true] }, scope)).toBe(true);
  });
  it("and: one false", () => {
    expect(evaluate({ and: [true, false] }, scope)).toBe(false);
  });
  it("and: with sub-expressions", () => {
    expect(evaluate({ and: [
      { eq: [{ select: ["context", "x"] }, 10] },
      { select: ["context", "a"] },
    ] }, scope)).toBe(true);
  });
  it("or: one true", () => {
    expect(evaluate({ or: [false, true] }, scope)).toBe(true);
  });
  it("or: all false", () => {
    expect(evaluate({ or: [false, false] }, scope)).toBe(false);
  });
  it("not: negates", () => {
    expect(evaluate({ not: false }, scope)).toBe(true);
    expect(evaluate({ not: { select: ["context", "a"] } }, scope)).toBe(false);
  });
  it("if: true branch", () => {
    expect(evaluate({ if: [true, "yes", "no"] }, scope)).toBe("yes");
  });
  it("if: false branch", () => {
    expect(evaluate({ if: [false, "yes", "no"] }, scope)).toBe("no");
  });
  it("cond: matches first true", () => {
    expect(evaluate({ cond: [
      [false, "a"],
      [true, "b"],
      [true, "c"],
    ] }, scope)).toBe("b");
  });
  it("cond: falls through to default", () => {
    expect(evaluate({ cond: [
      [false, "a"],
      [true, "default"],
    ] }, scope)).toBe("default");
  });
});

describe("evaluate — membership", () => {
  it("in: value is in array", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ in: ["b", ["a", "b", "c"]] }, scope)).toBe(true);
  });
  it("in: value is not in array", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ in: ["d", ["a", "b", "c"]] }, scope)).toBe(false);
  });
  it("in: with sub-expressions", () => {
    const scope = createScope({ context: {}, event: { type: "PASSED" } });
    expect(evaluate({
      in: [{ select: ["event", "type"] }, ["PASSED", "COMPLETED"]],
    }, scope)).toBe(true);
  });
});
