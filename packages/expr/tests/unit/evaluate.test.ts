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

describe("evaluate — ref and param", () => {
  it("ref: looks up binding", () => {
    const scope = createScope({ context: {} });
    scope.bindings = { myVal: 42 };
    expect(evaluate({ ref: "myVal" }, scope)).toBe(42);
  });

  it("ref: returns undefined for missing binding", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ ref: "missing" }, scope)).toBeUndefined();
  });

  it("param: looks up params", () => {
    const scope = createScope({ context: {}, params: { auId: "au-1" } });
    expect(evaluate({ param: "auId" }, scope)).toBe("au-1");
  });
});

describe("evaluate — let bindings", () => {
  it("binds values and evaluates body", () => {
    const scope = createScope({ context: { x: 10 } });
    expect(evaluate({
      let: [{ doubled: { add: [{ select: ["context", "x"] }, { select: ["context", "x"] }] } }, { ref: "doubled" }],
    }, scope)).toBe(20);
  });

  it("later bindings can reference earlier ones", () => {
    const scope = createScope({ context: { x: 5 } });
    expect(evaluate({
      let: [
        {
          a: { select: ["context", "x"] },
          b: { add: [{ ref: "a" }, 1] },
        },
        { ref: "b" },
      ],
    }, scope)).toBe(6);
  });

  it("does not leak bindings to outer scope", () => {
    const scope = createScope({ context: {} });
    evaluate({ let: [{ temp: 99 }, { ref: "temp" }] }, scope);
    expect(scope.bindings).toEqual({});
  });
});

describe("evaluate — nullability", () => {
  it("coalesce: returns first non-null value", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ coalesce: [null, undefined, 42] }, scope)).toBe(42);
  });

  it("coalesce: returns first if non-null", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ coalesce: ["first", "second"] }, scope)).toBe("first");
  });

  it("coalesce: evaluates sub-expressions", () => {
    const scope = createScope({ context: { x: null, y: "found" } });
    expect(evaluate({
      coalesce: [{ select: ["context", "x"] }, { select: ["context", "y"] }],
    }, scope)).toBe("found");
  });

  it("isNull: true for null", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ isNull: null }, scope)).toBe(true);
  });

  it("isNull: true for undefined (missing path)", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ isNull: { select: ["context", "missing"] } }, scope)).toBe(true);
  });

  it("isNull: false for value", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ isNull: 42 }, scope)).toBe(false);
  });
});

describe("evaluate — arithmetic", () => {
  const scope = createScope({ context: { x: 10, y: 3 } });

  it("add", () => {
    expect(evaluate({ add: [{ select: ["context", "x"] }, 5] }, scope)).toBe(15);
  });
  it("sub", () => {
    expect(evaluate({ sub: [{ select: ["context", "x"] }, 3] }, scope)).toBe(7);
  });
  it("mul", () => {
    expect(evaluate({ mul: [{ select: ["context", "x"] }, { select: ["context", "y"] }] }, scope)).toBe(30);
  });
  it("div", () => {
    expect(evaluate({ div: [{ select: ["context", "x"] }, 2] }, scope)).toBe(5);
  });
});

describe("evaluate — object construction", () => {
  it("constructs object with evaluated values", () => {
    const scope = createScope({ context: { score: 85 } });
    expect(evaluate({ object: { scaled: { select: ["context", "score"] } } }, scope)).toEqual({ scaled: 85 });
  });

  it("constructs nested object with literals", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ object: { a: 1, b: "two" } }, scope)).toEqual({ a: 1, b: "two" });
  });
});

describe("evaluate — merge", () => {
  it("combines two objects", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ merge: [{ object: { a: 1 } }, { object: { b: 2 } }] }, scope)).toEqual({ a: 1, b: 2 });
  });
  it("later keys win", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ merge: [{ object: { a: 1, b: 2 } }, { object: { b: 3 } }] }, scope)).toEqual({ a: 1, b: 3 });
  });
  it("skips non-objects and arrays", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ merge: [{ object: { a: 1 } }, 42, null, { object: { b: 2 } }] }, scope)).toEqual({ a: 1, b: 2 });
  });
  it("three+ objects", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ merge: [{ object: { a: 1 } }, { object: { b: 2 } }, { object: { c: 3 } }] }, scope)).toEqual({ a: 1, b: 2, c: 3 });
  });
  it("merges from context", () => {
    const scope = createScope({ context: { base: { x: 1 } } });
    expect(evaluate({ merge: [{ select: ["context", "base"] }, { object: { y: 2 } }] }, scope)).toEqual({ x: 1, y: 2 });
  });
});

describe("evaluate — len", () => {
  it("returns array length", () => {
    const scope = createScope({ context: { nums: [1, 2, 3, 4, 5] } });
    expect(evaluate({ len: { select: ["context", "nums"] } }, scope)).toBe(5);
  });
  it("returns object key count", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ len: { object: { a: 1, b: 2 } } }, scope)).toBe(2);
  });
  it("returns string length", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ len: "hello" }, scope)).toBe(5);
  });
  it("returns 0 for null", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ len: { select: ["context", "missing"] } }, scope)).toBe(0);
  });
  it("returns 0 for number", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ len: 42 }, scope)).toBe(0);
  });
});

describe("evaluate — at", () => {
  it("positive index", () => {
    const scope = createScope({ context: { items: ["a", "b", "c"] } });
    expect(evaluate({ at: [{ select: ["context", "items"] }, 1] }, scope)).toBe("b");
  });
  it("negative index (-1 = last)", () => {
    const scope = createScope({ context: { items: ["a", "b", "c"] } });
    expect(evaluate({ at: [{ select: ["context", "items"] }, -1] }, scope)).toBe("c");
  });
  it("out of bounds returns undefined", () => {
    const scope = createScope({ context: { items: ["a", "b"] } });
    expect(evaluate({ at: [{ select: ["context", "items"] }, 10] }, scope)).toBeUndefined();
  });
  it("non-array returns undefined", () => {
    const scope = createScope({ context: { val: 42 } });
    expect(evaluate({ at: [{ select: ["context", "val"] }, 0] }, scope)).toBeUndefined();
  });
  it("index from expression", () => {
    const scope = createScope({ context: { items: ["x", "y", "z"], idx: 2 } });
    expect(evaluate({ at: [{ select: ["context", "items"] }, { select: ["context", "idx"] }] }, scope)).toBe("z");
  });
});

describe("evaluate — filter", () => {
  const iterScope = createScope({ context: { nums: [1, 2, 3, 4, 5] } });

  it("keeps matching elements", () => {
    expect(evaluate(
      { filter: [{ select: ["context", "nums"] }, "n", { gt: [{ ref: "n" }, 3] }] },
      iterScope,
    )).toEqual([4, 5]);
  });
  it("returns [] for non-array", () => {
    const scope = createScope({ context: { val: 42 } });
    expect(evaluate(
      { filter: [{ select: ["context", "val"] }, "n", { ref: "n" }] },
      scope,
    )).toEqual([]);
  });
  it("returns [] for empty array", () => {
    const scope = createScope({ context: { items: [] } });
    expect(evaluate(
      { filter: [{ select: ["context", "items"] }, "n", true] },
      scope,
    )).toEqual([]);
  });
  it("$index binding available", () => {
    expect(evaluate(
      { filter: [{ select: ["context", "nums"] }, "n", { lt: [{ ref: "$index" }, 2] }] },
      iterScope,
    )).toEqual([1, 2]);
  });
});

describe("evaluate — filter (transducer)", () => {
  it("reads $ as collection", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = [1, 2, 3, 4, 5];
    expect(evaluate(
      { filter: ["n", { gt: [{ ref: "n" }, 3] }] },
      scope,
    )).toEqual([4, 5]);
  });
  it("returns [] when $ is not an array", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = 42;
    expect(evaluate({ filter: ["n", { ref: "n" }] }, scope)).toEqual([]);
  });
});

describe("evaluate — map", () => {
  const iterScope = createScope({ context: { nums: [1, 2, 3, 4, 5] } });

  it("transforms each element", () => {
    expect(evaluate(
      { map: [{ select: ["context", "nums"] }, "n", { mul: [{ ref: "n" }, 10] }] },
      iterScope,
    )).toEqual([10, 20, 30, 40, 50]);
  });
  it("$index binding available", () => {
    expect(evaluate(
      { map: [{ select: ["context", "nums"] }, "n", { ref: "$index" }] },
      iterScope,
    )).toEqual([0, 1, 2, 3, 4]);
  });
  it("returns [] for non-array", () => {
    const scope = createScope({ context: { val: "hello" } });
    expect(evaluate(
      { map: [{ select: ["context", "val"] }, "n", { ref: "n" }] },
      scope,
    )).toEqual([]);
  });
});

describe("evaluate — map (transducer)", () => {
  it("reads $ as collection", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = [1, 2, 3];
    expect(evaluate(
      { map: ["n", { mul: [{ ref: "n" }, 10] }] },
      scope,
    )).toEqual([10, 20, 30]);
  });
});

describe("evaluate — every", () => {
  const iterScope = createScope({ context: { nums: [1, 2, 3, 4, 5] } });

  it("true when all match", () => {
    expect(evaluate(
      { every: [{ select: ["context", "nums"] }, "n", { gt: [{ ref: "n" }, 0] }] },
      iterScope,
    )).toBe(true);
  });
  it("false when one fails", () => {
    expect(evaluate(
      { every: [{ select: ["context", "nums"] }, "n", { gt: [{ ref: "n" }, 3] }] },
      iterScope,
    )).toBe(false);
  });
  it("true for empty array", () => {
    const scope = createScope({ context: { items: [] } });
    expect(evaluate(
      { every: [{ select: ["context", "items"] }, "n", { ref: "n" }] },
      scope,
    )).toBe(true);
  });
  it("false for non-array", () => {
    const scope = createScope({ context: { val: 42 } });
    expect(evaluate(
      { every: [{ select: ["context", "val"] }, "n", { ref: "n" }] },
      scope,
    )).toBe(false);
  });
});

describe("evaluate — every (transducer)", () => {
  it("reads $ as collection", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = [2, 4, 6];
    expect(evaluate(
      { every: ["n", { eq: [{ div: [{ ref: "n" }, 2] }, { div: [{ ref: "n" }, 2] }] }] },
      scope,
    )).toBe(true);
  });
});

describe("evaluate — some", () => {
  const iterScope = createScope({ context: { nums: [1, 2, 3, 4, 5] } });

  it("true when at least one matches", () => {
    expect(evaluate(
      { some: [{ select: ["context", "nums"] }, "n", { gt: [{ ref: "n" }, 4] }] },
      iterScope,
    )).toBe(true);
  });
  it("false when none match", () => {
    expect(evaluate(
      { some: [{ select: ["context", "nums"] }, "n", { gt: [{ ref: "n" }, 10] }] },
      iterScope,
    )).toBe(false);
  });
  it("false for empty array", () => {
    const scope = createScope({ context: { items: [] } });
    expect(evaluate(
      { some: [{ select: ["context", "items"] }, "n", { ref: "n" }] },
      scope,
    )).toBe(false);
  });
  it("false for non-array", () => {
    const scope = createScope({ context: { val: 42 } });
    expect(evaluate(
      { some: [{ select: ["context", "val"] }, "n", { ref: "n" }] },
      scope,
    )).toBe(false);
  });
});

describe("evaluate — some (transducer)", () => {
  it("reads $ as collection", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = [1, 3, 5];
    expect(evaluate(
      { some: ["n", { gt: [{ ref: "n" }, 4] }] },
      scope,
    )).toBe(true);
  });
});
