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

describe("evaluate — reduce (eager with init)", () => {
  const iterScope = createScope({ context: { nums: [1, 2, 3, 4, 5] } });

  it("sums numbers", () => {
    expect(evaluate(
      { reduce: [{ select: ["context", "nums"] }, "acc", "n",
        { add: [{ ref: "acc" }, { ref: "n" }] }, 0] },
      iterScope,
    )).toBe(15);
  });
  it("returns init for empty array", () => {
    const scope = createScope({ context: { items: [] } });
    expect(evaluate({ reduce: [{ select: ["context", "items"] }, "acc", "n", { ref: "acc" }, 42] }, scope)).toBe(42);
  });
  it("returns init for non-array", () => {
    const scope = createScope({ context: { val: "hello" } });
    expect(evaluate({ reduce: [{ select: ["context", "val"] }, "acc", "n", { ref: "acc" }, 42] }, scope)).toBe(42);
  });
});

describe("evaluate — reduce (eager without init)", () => {
  it("finds max bid (first element as seed)", () => {
    const bidsScope = createScope({
      context: {
        bids: [
          { amount: 100, bidder: "A" },
          { amount: 250, bidder: "B" },
          { amount: 150, bidder: "C" },
        ],
      },
    });
    expect(evaluate(
      { reduce: [{ select: ["context", "bids"] }, "best", "b",
        { if: [
          { gt: [{ select: ["b", "amount"] }, { select: ["best", "amount"] }] },
          { ref: "b" },
          { ref: "best" },
        ]}
      ] },
      bidsScope,
    )).toEqual({ amount: 250, bidder: "B" });
  });
  it("single-element array returns that element", () => {
    const scope = createScope({ context: {} });
    expect(evaluate(
      { reduce: [[42], "acc", "n", { add: [{ ref: "acc" }, { ref: "n" }] }] },
      scope,
    )).toBe(42);
  });
  it("empty array returns undefined", () => {
    const scope = createScope({ context: {} });
    expect(evaluate(
      { reduce: [[], "acc", "n", { add: [{ ref: "acc" }, { ref: "n" }] }] },
      scope,
    )).toBeUndefined();
  });
});

describe("evaluate — reduce (transducer)", () => {
  it("reads $ as collection with init", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = [1, 2, 3, 4, 5];
    expect(evaluate(
      { reduce: ["acc", "n", { add: [{ ref: "acc" }, { ref: "n" }] }, 0] },
      scope,
    )).toBe(15);
  });
  it("transducer without init", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = [1, 2, 3];
    expect(evaluate(
      { reduce: ["acc", "n", { add: [{ ref: "acc" }, { ref: "n" }] }] },
      scope,
    )).toBe(6);
  });
});

describe("evaluate — pipe", () => {
  const iterScope = createScope({ context: { nums: [1, 2, 3, 4, 5] } });

  it("threads value through steps", () => {
    expect(evaluate(
      { pipe: [
        { select: ["context", "nums"] },
        { filter: ["n", { gt: [{ ref: "n" }, 2] }] },
        { map: ["n", { mul: [{ ref: "n" }, 10] }] },
      ]},
      iterScope,
    )).toEqual([30, 40, 50]);
  });

  it("works with unary operators via ref", () => {
    expect(evaluate(
      { pipe: [
        { select: ["context", "nums"] },
        { filter: ["n", { gt: [{ ref: "n" }, 3] }] },
        { len: { ref: "$" } },
      ]},
      iterScope,
    )).toBe(2);
  });

  it("single step returns that step's result", () => {
    expect(evaluate({ pipe: [42] }, iterScope)).toBe(42);
  });

  it("empty pipe returns undefined", () => {
    expect(evaluate({ pipe: [] }, iterScope)).toBeUndefined();
  });

  it("reduce in pipe (transducer form)", () => {
    expect(evaluate(
      { pipe: [
        { select: ["context", "nums"] },
        { reduce: ["acc", "n", { add: [{ ref: "acc" }, { ref: "n" }] }, 0] },
      ]},
      iterScope,
    )).toBe(15);
  });

  it("filter + map + reduce pipeline", () => {
    const scope = createScope({
      context: {
        todos: [
          { title: "A", completed: false },
          { title: "BB", completed: true },
          { title: "CCC", completed: false },
        ],
      },
    });
    // Get total title length of incomplete todos
    expect(evaluate(
      { pipe: [
        { select: ["context", "todos"] },
        { filter: ["t", { not: { select: ["t", "completed"] } }] },
        { map: ["t", { len: { select: ["t", "title"] } }] },
        { reduce: ["acc", "n", { add: [{ ref: "acc" }, { ref: "n" }] }, 0] },
      ]},
      scope,
    )).toBe(4); // "A"(1) + "CCC"(3)
  });
});

describe("evaluate — mapVals", () => {
  it("transforms all values", () => {
    const scope = createScope({ context: { scores: { math: 80, english: 90 } } });
    expect(evaluate(
      { mapVals: [{ select: ["context", "scores"] }, "v", { mul: [{ ref: "v" }, 2] }] },
      scope,
    )).toEqual({ math: 160, english: 180 });
  });
  it("$key binding available", () => {
    const scope = createScope({ context: { items: { a: 1, b: 2 } } });
    expect(evaluate(
      { mapVals: [{ select: ["context", "items"] }, "v", { ref: "$key" }] },
      scope,
    )).toEqual({ a: "a", b: "b" });
  });
  it("returns {} for non-object", () => {
    const scope = createScope({ context: { val: 42 } });
    expect(evaluate(
      { mapVals: [{ select: ["context", "val"] }, "v", { ref: "v" }] },
      scope,
    )).toEqual({});
  });
  it("returns {} for array input", () => {
    const scope = createScope({ context: { items: [1, 2, 3] } });
    expect(evaluate(
      { mapVals: [{ select: ["context", "items"] }, "v", { ref: "v" }] },
      scope,
    )).toEqual({});
  });
});

describe("evaluate — mapVals (transducer)", () => {
  it("reads $ as object", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = { x: 1, y: 2 };
    expect(evaluate(
      { mapVals: ["v", { add: [{ ref: "v" }, 10] }] },
      scope,
    )).toEqual({ x: 11, y: 12 });
  });
});

describe("evaluate — filterKeys", () => {
  it("keeps entries matching predicate", () => {
    const scope = createScope({ context: { scores: { math: 80, english: 50, science: 90 } } });
    expect(evaluate(
      { filterKeys: [{ select: ["context", "scores"] }, "v", { gte: [{ ref: "v" }, 80] }] },
      scope,
    )).toEqual({ math: 80, science: 90 });
  });
  it("$key binding available", () => {
    const scope = createScope({ context: { items: { a: 1, b: 2, c: 3 } } });
    expect(evaluate(
      { filterKeys: [{ select: ["context", "items"] }, "v", { eq: [{ ref: "$key" }, "b"] }] },
      scope,
    )).toEqual({ b: 2 });
  });
  it("returns {} for non-object", () => {
    const scope = createScope({ context: { val: 42 } });
    expect(evaluate(
      { filterKeys: [{ select: ["context", "val"] }, "v", true] },
      scope,
    )).toEqual({});
  });
  it("returns {} for array input", () => {
    const scope = createScope({ context: { items: [1, 2] } });
    expect(evaluate(
      { filterKeys: [{ select: ["context", "items"] }, "v", true] },
      scope,
    )).toEqual({});
  });
});

describe("evaluate — filterKeys (transducer)", () => {
  it("reads $ as object", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = { x: 1, y: 2, z: 3 };
    expect(evaluate(
      { filterKeys: ["v", { gt: [{ ref: "v" }, 1] }] },
      scope,
    )).toEqual({ y: 2, z: 3 });
  });
});

describe("evaluate — deepSelect", () => {
  it("finds all matching nodes recursively", () => {
    const scope = createScope({
      context: {
        tree: {
          name: "root",
          children: [
            { name: "a", children: [{ name: "a1" }] },
            { name: "b" },
          ],
        },
      },
    });
    const result = evaluate(
      { deepSelect: [{ select: ["context", "tree"] }, "node",
        { in: [{ select: ["node", "name"] }, ["a", "a1"]] }
      ] },
      scope,
    ) as unknown[];
    // Should find objects with name "a" and "a1"
    const names = result.map((n: any) => n.name);
    expect(names).toContain("a");
    expect(names).toContain("a1");
    expect(names).not.toContain("root");
    expect(names).not.toContain("b");
  });
  it("returns [] when nothing matches", () => {
    const scope = createScope({ context: { data: { a: 1, b: 2 } } });
    expect(evaluate(
      { deepSelect: [{ select: ["context", "data"] }, "node", { eq: [{ ref: "node" }, 999] }] },
      scope,
    )).toEqual([]);
  });
  it("finds primitive values in nested structures", () => {
    const scope = createScope({ context: { data: { a: 1, b: { c: 2, d: { e: 3 } } } } });
    const result = evaluate(
      { deepSelect: [{ select: ["context", "data"] }, "node", { eq: [{ ref: "node" }, 2] }] },
      scope,
    );
    expect(result).toEqual([2]);
  });
});

describe("evaluate — deepSelect (transducer)", () => {
  it("reads $ as source", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = { a: 1, b: { c: 2 } };
    expect(evaluate(
      { deepSelect: ["node", { eq: [{ ref: "node" }, 2] }] },
      scope,
    )).toEqual([2]);
  });
});

describe("evaluate — pick", () => {
  it("extracts subset of keys", () => {
    const scope = createScope({ context: { user: { name: "Alice", age: 30, email: "a@b.c" } } });
    expect(evaluate(
      { pick: [{ select: ["context", "user"] }, ["name", "email"]] },
      scope,
    )).toEqual({ name: "Alice", email: "a@b.c" });
  });
  it("ignores missing keys", () => {
    const scope = createScope({ context: { obj: { a: 1, b: 2 } } });
    expect(evaluate(
      { pick: [{ select: ["context", "obj"] }, ["a", "missing"]] },
      scope,
    )).toEqual({ a: 1 });
  });
  it("returns {} for non-object", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ pick: [42, ["a"]] }, scope)).toEqual({});
  });
  it("returns {} for non-array keys", () => {
    const scope = createScope({ context: { obj: { a: 1 } } });
    expect(evaluate({ pick: [{ select: ["context", "obj"] }, "not-array"] }, scope)).toEqual({});
  });
});

describe("evaluate — prepend", () => {
  it("inserts value at beginning", () => {
    const scope = createScope({ context: { items: [2, 3] } });
    expect(evaluate(
      { prepend: [{ select: ["context", "items"] }, 1] },
      scope,
    )).toEqual([1, 2, 3]);
  });
  it("wraps non-array in array with value", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ prepend: [42, "first"] }, scope)).toEqual(["first"]);
  });
  it("prepend to empty array", () => {
    const scope = createScope({ context: { items: [] } });
    expect(evaluate(
      { prepend: [{ select: ["context", "items"] }, "x"] },
      scope,
    )).toEqual(["x"]);
  });
});

describe("evaluate — multiSelect", () => {
  it("evaluates multiple expressions into array", () => {
    const scope = createScope({ context: { a: 1, b: 2 } });
    expect(evaluate(
      { multiSelect: [{ select: ["context", "a"] }, { select: ["context", "b"] }, 42] },
      scope,
    )).toEqual([1, 2, 42]);
  });
  it("empty multiSelect returns empty array", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ multiSelect: [] }, scope)).toEqual([]);
  });
  it("single expression", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ multiSelect: [true] }, scope)).toEqual([true]);
  });
});

describe("evaluate — condPath", () => {
  it("evaluates matching branch with $ bound to input", () => {
    const scope = createScope({ context: { val: 5 } });
    expect(evaluate(
      { condPath: [
        { select: ["context", "val"] },
        [{ gt: [{ ref: "$" }, 10] }, "big"],
        [{ gt: [{ ref: "$" }, 3] }, "medium"],
        [true, "small"],
      ] },
      scope,
    )).toBe("medium");
  });
  it("returns undefined when no branch matches", () => {
    const scope = createScope({ context: {} });
    expect(evaluate(
      { condPath: [42, [{ gt: [{ ref: "$" }, 100] }, "big"]] },
      scope,
    )).toBeUndefined();
  });
  it("transforms input in result expression", () => {
    const scope = createScope({ context: { n: 3 } });
    expect(evaluate(
      { condPath: [
        { select: ["context", "n"] },
        [{ gt: [{ ref: "$" }, 0] }, { mul: [{ ref: "$" }, 2] }],
        [true, 0],
      ] },
      scope,
    )).toBe(6);
  });
  it("works in pipe", () => {
    const scope = createScope({ context: { nums: [1, 15, 3, 25] } });
    expect(evaluate(
      { pipe: [
        { select: ["context", "nums"] },
        { map: ["n", { condPath: [
          { ref: "n" },
          [{ gt: [{ ref: "$" }, 10] }, "big"],
          [true, "small"],
        ]}] },
      ] },
      scope,
    )).toEqual(["small", "big", "small", "big"]);
  });
});

describe("evaluate — concat", () => {
  it("concatenates two arrays", () => {
    const scope = createScope({ context: { a: [1, 2], b: [3, 4] } });
    expect(evaluate(
      { concat: [{ select: ["context", "a"] }, { select: ["context", "b"] }] },
      scope,
    )).toEqual([1, 2, 3, 4]);
  });
  it("concatenates three+ arrays", () => {
    const scope = createScope({ context: {} });
    expect(evaluate(
      { concat: [[1], [2, 3], [4, 5, 6]] },
      scope,
    )).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("treats non-array values as single elements", () => {
    const scope = createScope({ context: {} });
    expect(evaluate(
      { concat: [[1, 2], 3, [4]] },
      scope,
    )).toEqual([1, 2, 3, 4]);
  });
  it("single array returns shallow copy", () => {
    const scope = createScope({ context: { items: [1, 2, 3] } });
    const result = evaluate(
      { concat: [{ select: ["context", "items"] }] },
      scope,
    );
    expect(result).toEqual([1, 2, 3]);
    expect(result).not.toBe(scope.context.items); // new array
  });
  it("no arguments returns empty array", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ concat: [] }, scope)).toEqual([]);
  });
  it("all non-array values", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ concat: [1, "two", true] }, scope)).toEqual([1, "two", true]);
  });
  it("handles null/undefined elements", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ concat: [[1], null, [2]] }, scope)).toEqual([1, null, 2]);
  });
  it("works with expressions", () => {
    const scope = createScope({
      context: {
        existing: [{ id: 1 }, { id: 2 }],
      },
      event: { newItem: { id: 3 } },
    });
    expect(evaluate(
      { concat: [{ select: ["context", "existing"] }, { select: ["event", "newItem"] }] },
      scope,
    )).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });
  it("works in pipe with transducer operators", () => {
    const scope = createScope({ context: { a: [1, 2, 3], b: [4, 5, 6] } });
    expect(evaluate(
      { pipe: [
        { concat: [{ select: ["context", "a"] }, { select: ["context", "b"] }] },
        { filter: ["n", { gt: [{ ref: "n" }, 3] }] },
      ]},
      scope,
    )).toEqual([4, 5, 6]);
  });
});
