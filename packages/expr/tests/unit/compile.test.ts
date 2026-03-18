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
