import { describe, it, expect } from "vitest";
import { compile } from "../../src/compile.js";
import { evaluate } from "../../src/evaluate.js";
import { createScope } from "../../src/types.js";
import { createBuiltinRegistry } from "../../src/builtins.js";
import type { Scope, Expr } from "../../src/types.js";

const emptyScope = createScope({ context: {} });

/** Helper: verify compiled result matches interpreted result. */
function expectCompiledMatchesEvaluated(expr: Expr, scope: Scope, builtins = undefined as any) {
  const compiled = compile(expr, builtins);
  expect(compiled(scope)).toEqual(evaluate(expr, scope, builtins));
}

describe("compile — literals", () => {
  it("null", () => expect(compile(null)(emptyScope)).toBe(null));
  it("undefined", () => expect(compile(undefined)(emptyScope)).toBe(undefined));
  it("string", () => expect(compile("hello")(emptyScope)).toBe("hello"));
  it("number", () => expect(compile(42)(emptyScope)).toBe(42));
  it("boolean", () => expect(compile(true)(emptyScope)).toBe(true));
  it("array", () => expect(compile([1, 2])(emptyScope)).toEqual([1, 2]));
});

describe("compile — select", () => {
  it("context path", () => {
    const fn = compile({ select: ["context", "name"] });
    expect(fn(createScope({ context: { name: "Alice" } }))).toBe("Alice");
  });

  it("event path", () => {
    const fn = compile({ select: ["event", "type"] });
    expect(fn(createScope({ context: {}, event: { type: "CLICK" } }))).toBe("CLICK");
  });

  it("params path", () => {
    const fn = compile({ select: ["params", "id"] });
    expect(fn(createScope({ context: {}, params: { id: "x" } }))).toBe("x");
  });

  it("nested path", () => {
    const fn = compile({ select: ["context", "a", "b", "c"] });
    expect(fn(createScope({ context: { a: { b: { c: 42 } } } }))).toBe(42);
  });

  it("missing path returns undefined", () => {
    const fn = compile({ select: ["context", "missing"] });
    expect(fn(createScope({ context: {} }))).toBe(undefined);
  });

  it("param path step", () => {
    const fn = compile({ select: ["context", "items", { param: "key" }] });
    const scope = createScope({ context: { items: { x: 1 } }, params: { key: "x" } });
    expect(fn(scope)).toBe(1);
  });

  it("ref path step", () => {
    const fn = compile({ select: ["context", "items", { ref: "k" }] });
    const scope = createScope({ context: { items: { y: 2 } } });
    scope.bindings.k = "y";
    expect(fn(scope)).toBe(2);
  });

  it("where path step", () => {
    const fn = compile({ select: ["context", "sessions", { where: { eq: ["state", "active"] } }] });
    const scope = createScope({
      context: {
        sessions: {
          s1: { state: "active", auId: "a" },
          s2: { state: "terminated", auId: "b" },
        },
      },
    });
    const result = fn(scope) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["s1"]);
  });

  it("arbitrary expr path step", () => {
    const fn = compile({ select: ["context", "items", { select: ["event", "key"] }] });
    const scope = createScope({ context: { items: { x: 99 } }, event: { key: "x" } });
    expect(fn(scope)).toBe(99);
  });
});

describe("compile — comparisons", () => {
  for (const [op, a, b, expected] of [
    ["eq", 1, 1, true], ["eq", 1, 2, false],
    ["neq", 1, 2, true], ["neq", 1, 1, false],
    ["gt", 3, 2, true], ["gt", 2, 3, false],
    ["lt", 2, 3, true], ["lt", 3, 2, false],
    ["gte", 3, 3, true], ["gte", 2, 3, false],
    ["lte", 3, 3, true], ["lte", 4, 3, false],
  ] as const) {
    it(`${op}([${a}, ${b}]) → ${expected}`, () => {
      expect(compile({ [op]: [a, b] })(emptyScope)).toBe(expected);
    });
  }
});

describe("compile — logic", () => {
  it("and — all true", () => expect(compile({ and: [true, true] })(emptyScope)).toBe(true));
  it("and — one false", () => expect(compile({ and: [true, false] })(emptyScope)).toBe(false));
  it("or — one true", () => expect(compile({ or: [false, true] })(emptyScope)).toBe(true));
  it("or — all false", () => expect(compile({ or: [false, false] })(emptyScope)).toBe(false));
  it("not — true", () => expect(compile({ not: true })(emptyScope)).toBe(false));
  it("if — truthy", () => expect(compile({ if: [true, "yes", "no"] })(emptyScope)).toBe("yes"));
  it("if — falsy", () => expect(compile({ if: [false, "yes", "no"] })(emptyScope)).toBe("no"));
  it("cond — first match", () => {
    const fn = compile({ cond: [[false, "a"], [true, "b"], [true, "c"]] });
    expect(fn(emptyScope)).toBe("b");
  });
  it("cond — no match", () => {
    expect(compile({ cond: [[false, "a"]] })(emptyScope)).toBe(undefined);
  });
});

describe("compile — membership", () => {
  it("in — found", () => expect(compile({ in: [2, [1, 2, 3]] })(emptyScope)).toBe(true));
  it("in — not found", () => expect(compile({ in: [9, [1, 2, 3]] })(emptyScope)).toBe(false));
  it("in — non-array", () => expect(compile({ in: [1, "not-array"] })(emptyScope)).toBe(false));
});

describe("compile — ref and param", () => {
  it("ref", () => {
    const scope = createScope({ context: {} });
    scope.bindings.x = 42;
    expect(compile({ ref: "x" })(scope)).toBe(42);
  });
  it("param", () => {
    const scope = createScope({ context: {}, params: { id: "abc" } });
    expect(compile({ param: "id" })(scope)).toBe("abc");
  });
});

describe("compile — let", () => {
  it("binds and evaluates body", () => {
    const fn = compile({ let: [{ doubled: { mul: [{ param: "n" }, 2] } }, { ref: "doubled" }] });
    const scope = createScope({ context: {}, params: { n: 5 } });
    expect(fn(scope)).toBe(10);
  });

  it("sequential bindings reference earlier ones", () => {
    const fn = compile({
      let: [{ a: 1, b: { add: [{ ref: "a" }, 1] } }, { ref: "b" }],
    });
    expect(fn(emptyScope)).toBe(2);
  });
});

describe("compile — nullability", () => {
  it("coalesce — first non-null", () => {
    expect(compile({ coalesce: [null, undefined, "found"] })(emptyScope)).toBe("found");
  });
  it("coalesce — all null", () => {
    expect(compile({ coalesce: [null, undefined] })(emptyScope)).toBe(undefined);
  });
  it("isNull — null", () => expect(compile({ isNull: null })(emptyScope)).toBe(true));
  it("isNull — value", () => expect(compile({ isNull: 42 })(emptyScope)).toBe(false));
});

describe("compile — arithmetic", () => {
  it("add", () => expect(compile({ add: [3, 4] })(emptyScope)).toBe(7));
  it("sub", () => expect(compile({ sub: [10, 3] })(emptyScope)).toBe(7));
  it("mul", () => expect(compile({ mul: [3, 4] })(emptyScope)).toBe(12));
  it("div", () => expect(compile({ div: [10, 2] })(emptyScope)).toBe(5));
});

describe("compile — object", () => {
  it("constructs object with evaluated values", () => {
    const fn = compile({ object: { name: { select: ["context", "name"] }, age: 30 } });
    expect(fn(createScope({ context: { name: "Alice" } }))).toEqual({ name: "Alice", age: 30 });
  });
});

describe("compile — merge", () => {
  it("combines objects", () => {
    expect(compile({ merge: [{ object: { a: 1 } }, { object: { b: 2 } }] })(emptyScope)).toEqual({ a: 1, b: 2 });
  });
  it("later keys win", () => {
    expect(compile({ merge: [{ object: { a: 1 } }, { object: { a: 2 } }] })(emptyScope)).toEqual({ a: 2 });
  });
  it("skips non-objects", () => {
    expect(compile({ merge: [{ object: { a: 1 } }, 42, { object: { b: 2 } }] })(emptyScope)).toEqual({ a: 1, b: 2 });
  });
});

describe("compile — len", () => {
  it("array length", () => {
    const scope = createScope({ context: { items: [1, 2, 3] } });
    expect(compile({ len: { select: ["context", "items"] } })(scope)).toBe(3);
  });
  it("object key count", () => {
    expect(compile({ len: { object: { a: 1, b: 2 } } })(emptyScope)).toBe(2);
  });
  it("string length", () => {
    expect(compile({ len: "hello" })(emptyScope)).toBe(5);
  });
  it("0 for null/undefined", () => {
    expect(compile({ len: { select: ["context", "missing"] } })(emptyScope)).toBe(0);
  });
});

describe("compile — at", () => {
  it("positive index", () => {
    const scope = createScope({ context: { items: ["a", "b", "c"] } });
    expect(compile({ at: [{ select: ["context", "items"] }, 1] })(scope)).toBe("b");
  });
  it("negative index", () => {
    const scope = createScope({ context: { items: ["a", "b", "c"] } });
    expect(compile({ at: [{ select: ["context", "items"] }, -1] })(scope)).toBe("c");
  });
  it("non-array returns undefined", () => {
    expect(compile({ at: ["not-array", 0] })(emptyScope)).toBeUndefined();
  });
});

describe("compile — filter", () => {
  it("keeps matching elements", () => {
    const scope = createScope({ context: { nums: [1, 2, 3, 4, 5] } });
    expect(compile({ filter: [{ select: ["context", "nums"] }, "n", { gt: [{ ref: "n" }, 3] }] })(scope)).toEqual([4, 5]);
  });
  it("transducer form reads $", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = [1, 2, 3, 4, 5];
    expect(compile({ filter: ["n", { gt: [{ ref: "n" }, 3] }] })(scope)).toEqual([4, 5]);
  });
  it("returns [] for non-array", () => {
    expect(compile({ filter: [42, "n", { ref: "n" }] })(emptyScope)).toEqual([]);
  });
});

describe("compile — map", () => {
  it("transforms each element", () => {
    const scope = createScope({ context: { nums: [1, 2, 3] } });
    expect(compile({ map: [{ select: ["context", "nums"] }, "n", { mul: [{ ref: "n" }, 2] }] })(scope)).toEqual([2, 4, 6]);
  });
  it("transducer form reads $", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = [10, 20];
    expect(compile({ map: ["n", { add: [{ ref: "n" }, 1] }] })(scope)).toEqual([11, 21]);
  });
  it("returns [] for non-array", () => {
    expect(compile({ map: ["not-array", "n", { ref: "n" }] })(emptyScope)).toEqual([]);
  });
});

describe("compile — every", () => {
  it("true when all match", () => {
    const scope = createScope({ context: { nums: [1, 2, 3] } });
    expect(compile({ every: [{ select: ["context", "nums"] }, "n", { gt: [{ ref: "n" }, 0] }] })(scope)).toBe(true);
  });
  it("false when one fails", () => {
    const scope = createScope({ context: { nums: [1, 2, 3] } });
    expect(compile({ every: [{ select: ["context", "nums"] }, "n", { gt: [{ ref: "n" }, 2] }] })(scope)).toBe(false);
  });
  it("transducer form", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = [2, 4, 6];
    expect(compile({ every: ["n", { gt: [{ ref: "n" }, 0] }] })(scope)).toBe(true);
  });
});

describe("compile — some", () => {
  it("true when one matches", () => {
    const scope = createScope({ context: { nums: [1, 2, 3] } });
    expect(compile({ some: [{ select: ["context", "nums"] }, "n", { gt: [{ ref: "n" }, 2] }] })(scope)).toBe(true);
  });
  it("false when none match", () => {
    const scope = createScope({ context: { nums: [1, 2, 3] } });
    expect(compile({ some: [{ select: ["context", "nums"] }, "n", { gt: [{ ref: "n" }, 5] }] })(scope)).toBe(false);
  });
  it("transducer form", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = [1, 3, 5];
    expect(compile({ some: ["n", { gt: [{ ref: "n" }, 4] }] })(scope)).toBe(true);
  });
});

describe("compile — reduce", () => {
  it("eager with init — sums", () => {
    const scope = createScope({ context: { nums: [1, 2, 3] } });
    expect(compile({ reduce: [{ select: ["context", "nums"] }, "acc", "n", { add: [{ ref: "acc" }, { ref: "n" }] }, 0] })(scope)).toBe(6);
  });
  it("eager without init — first as seed", () => {
    const scope = createScope({ context: { nums: [10, 20, 30] } });
    expect(compile({ reduce: [{ select: ["context", "nums"] }, "acc", "n", { add: [{ ref: "acc" }, { ref: "n" }] }] })(scope)).toBe(60);
  });
  it("transducer with init", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = [1, 2, 3];
    expect(compile({ reduce: ["acc", "n", { add: [{ ref: "acc" }, { ref: "n" }] }, 0] })(scope)).toBe(6);
  });
  it("transducer without init", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = [5, 10];
    expect(compile({ reduce: ["acc", "n", { add: [{ ref: "acc" }, { ref: "n" }] }] })(scope)).toBe(15);
  });
  it("empty with init returns init", () => {
    const scope = createScope({ context: { items: [] } });
    expect(compile({ reduce: [{ select: ["context", "items"] }, "acc", "n", { ref: "acc" }, 99] })(scope)).toBe(99);
  });
});

describe("compile — fn (builtins)", () => {
  it("calls builtin with no args", () => {
    const builtins = createBuiltinRegistry({ fixed: () => "ok" });
    expect(compile({ fn: ["fixed"] }, builtins)(emptyScope)).toBe("ok");
  });

  it("calls builtin with args", () => {
    const builtins = createBuiltinRegistry({ sum: (a: unknown, b: unknown) => (a as number) + (b as number) });
    expect(compile({ fn: ["sum", 3, 4] }, builtins)(emptyScope)).toBe(7);
  });

  it("missing builtin returns undefined", () => {
    expect(compile({ fn: ["missing"] })(emptyScope)).toBe(undefined);
  });

  it("impure builtins called fresh each time", () => {
    let counter = 0;
    const builtins = createBuiltinRegistry({ inc: () => ++counter });
    const fn = compile({ fn: ["inc"] }, builtins);
    expect(fn(emptyScope)).toBe(1);
    expect(fn(emptyScope)).toBe(2);
  });
});

describe("compile — pipe", () => {
  it("threads value through steps", () => {
    const scope = createScope({ context: { nums: [1, 2, 3, 4, 5] } });
    expect(compile({ pipe: [
      { select: ["context", "nums"] },
      { filter: ["n", { gt: [{ ref: "n" }, 2] }] },
      { map: ["n", { mul: [{ ref: "n" }, 10] }] },
    ]})(scope)).toEqual([30, 40, 50]);
  });
  it("works with len via ref", () => {
    const scope = createScope({ context: { items: [1, 2, 3] } });
    expect(compile({ pipe: [
      { select: ["context", "items"] },
      { len: { ref: "$" } },
    ]})(scope)).toBe(3);
  });
  it("single step", () => {
    expect(compile({ pipe: [42] })(emptyScope)).toBe(42);
  });
  it("empty pipe", () => {
    expect(compile({ pipe: [] })(emptyScope)).toBeUndefined();
  });
});

describe("compile — mapVals", () => {
  it("transforms all values", () => {
    const scope = createScope({ context: { scores: { a: 10, b: 20 } } });
    expect(compile({ mapVals: [{ select: ["context", "scores"] }, "v", { mul: [{ ref: "v" }, 3] }] })(scope)).toEqual({ a: 30, b: 60 });
  });
  it("transducer form", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = { x: 5 };
    expect(compile({ mapVals: ["v", { add: [{ ref: "v" }, 1] }] })(scope)).toEqual({ x: 6 });
  });
  it("returns {} for non-object", () => {
    expect(compile({ mapVals: [42, "v", { ref: "v" }] })(emptyScope)).toEqual({});
  });
});

describe("compile — filterKeys", () => {
  it("keeps entries matching predicate", () => {
    const scope = createScope({ context: { scores: { math: 80, english: 50, science: 90 } } });
    expect(compile({ filterKeys: [{ select: ["context", "scores"] }, "v", { gte: [{ ref: "v" }, 80] }] })(scope)).toEqual({ math: 80, science: 90 });
  });
  it("transducer form", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = { a: 1, b: 2, c: 3 };
    expect(compile({ filterKeys: ["v", { gt: [{ ref: "v" }, 1] }] })(scope)).toEqual({ b: 2, c: 3 });
  });
  it("returns {} for non-object", () => {
    expect(compile({ filterKeys: [42, "v", true] })(emptyScope)).toEqual({});
  });
});

describe("compile — deepSelect", () => {
  it("finds matching nodes recursively", () => {
    const scope = createScope({ context: { data: { a: 1, b: { c: 2, d: { e: 2 } } } } });
    expect(compile({ deepSelect: [{ select: ["context", "data"] }, "node", { eq: [{ ref: "node" }, 2] }] })(scope)).toEqual([2, 2]);
  });
  it("transducer form", () => {
    const scope = createScope({ context: {} });
    scope.bindings.$ = { x: 5, y: { z: 5 } };
    expect(compile({ deepSelect: ["node", { eq: [{ ref: "node" }, 5] }] })(scope)).toEqual([5, 5]);
  });
  it("returns [] when nothing matches", () => {
    expect(compile({ deepSelect: [{ object: { a: 1 } }, "n", { eq: [{ ref: "n" }, 99] }] })(emptyScope)).toEqual([]);
  });
});

describe("compile — pick", () => {
  it("extracts subset of keys", () => {
    const scope = createScope({ context: { obj: { a: 1, b: 2, c: 3 } } });
    expect(compile({ pick: [{ select: ["context", "obj"] }, ["a", "c"]] })(scope)).toEqual({ a: 1, c: 3 });
  });
  it("ignores missing keys", () => {
    expect(compile({ pick: [{ object: { x: 1 } }, ["x", "y"]] })(emptyScope)).toEqual({ x: 1 });
  });
  it("returns {} for non-object", () => {
    expect(compile({ pick: [42, ["a"]] })(emptyScope)).toEqual({});
  });
});

describe("compile — prepend", () => {
  it("inserts at beginning", () => {
    const scope = createScope({ context: { items: [2, 3] } });
    expect(compile({ prepend: [{ select: ["context", "items"] }, 1] })(scope)).toEqual([1, 2, 3]);
  });
  it("wraps non-array", () => {
    expect(compile({ prepend: [42, "first"] })(emptyScope)).toEqual(["first"]);
  });
});

describe("compile — multiSelect", () => {
  it("evaluates multiple expressions into array", () => {
    const scope = createScope({ context: { a: 1 } });
    expect(compile({ multiSelect: [{ select: ["context", "a"] }, 42, true] })(scope)).toEqual([1, 42, true]);
  });
  it("empty returns []", () => {
    expect(compile({ multiSelect: [] })(emptyScope)).toEqual([]);
  });
});

describe("compile — condPath", () => {
  it("evaluates matching branch with $ bound", () => {
    const scope = createScope({ context: { val: 5 } });
    expect(compile({ condPath: [
      { select: ["context", "val"] },
      [{ gt: [{ ref: "$" }, 10] }, "big"],
      [{ gt: [{ ref: "$" }, 3] }, "medium"],
      [true, "small"],
    ] })(scope)).toBe("medium");
  });
  it("returns undefined when no match", () => {
    expect(compile({ condPath: [42, [{ gt: [{ ref: "$" }, 100] }, "big"]] })(emptyScope)).toBeUndefined();
  });
  it("transforms input in result", () => {
    expect(compile({ condPath: [5, [{ gt: [{ ref: "$" }, 0] }, { mul: [{ ref: "$" }, 3] }]] })(emptyScope)).toBe(15);
  });
});

describe("compile — equivalence with evaluate", () => {
  const testCases: [string, Expr, Scope][] = [
    ["nested select + eq", { eq: [{ select: ["context", "x"] }, 5] }, createScope({ context: { x: 5 } })],
    ["let + cond", {
      let: [{ v: { select: ["event", "type"] } }, { cond: [[{ eq: [{ ref: "v" }, "A"] }, 1], [true, 0]] }],
    }, createScope({ context: {}, event: { type: "A" } })],
  ];

  for (const [name, expr, scope] of testCases) {
    it(name, () => expectCompiledMatchesEvaluated(expr, scope));
  }
});
