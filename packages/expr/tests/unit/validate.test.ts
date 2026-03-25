import { describe, it, expect } from "vitest";
import { validateExprComplexity, ExprComplexityExceeded } from "../../src/validate.js";
import type { ComplexityLimits } from "../../src/validate.js";

const generous: ComplexityLimits = { maxOperatorCount: 500, maxDepth: 15 };

describe("validateExprComplexity", () => {
  // ─── Primitives ─────────────────────────────────────────────────────────

  it("string: count 0, depth 0", () => {
    expect(validateExprComplexity("hello", generous)).toEqual({ operatorCount: 0, maxDepth: 0 });
  });

  it("number: count 0, depth 0", () => {
    expect(validateExprComplexity(42, generous)).toEqual({ operatorCount: 0, maxDepth: 0 });
  });

  it("null: count 0, depth 0", () => {
    expect(validateExprComplexity(null, generous)).toEqual({ operatorCount: 0, maxDepth: 0 });
  });

  it("boolean: count 0, depth 0", () => {
    expect(validateExprComplexity(true, generous)).toEqual({ operatorCount: 0, maxDepth: 0 });
  });

  // ─── Simple expressions ─────────────────────────────────────────────────

  it("simple eq: count 1, depth 1", () => {
    expect(validateExprComplexity({ eq: [1, 2] }, generous)).toEqual({ operatorCount: 1, maxDepth: 1 });
  });

  it("ref: count 0, depth 0 (not an operator in the walk)", () => {
    // {ref: "x"} has key "ref" which IS in EXPR_OPERATORS
    expect(validateExprComplexity({ ref: "x" }, generous)).toEqual({ operatorCount: 1, maxDepth: 1 });
  });

  it("param: count 1, depth 1", () => {
    expect(validateExprComplexity({ param: "x" }, generous)).toEqual({ operatorCount: 1, maxDepth: 1 });
  });

  // ─── Nested expressions ─────────────────────────────────────────────────

  it("nested: depth tracks correctly", () => {
    // { eq: [{ add: [1, 2] }, 3] } → eq at depth 1, add at depth 2
    const result = validateExprComplexity({ eq: [{ add: [1, 2] }, 3] }, generous);
    expect(result.operatorCount).toBe(2);
    expect(result.maxDepth).toBe(2);
  });

  it("wide expression: and with 10 operands", () => {
    const operands = Array.from({ length: 10 }, (_, i) => ({ eq: [i, i] }));
    const result = validateExprComplexity({ and: operands }, generous);
    // 1 (and) + 10 (eq) = 11 operators, max depth = 2 (and → eq)
    expect(result.operatorCount).toBe(11);
    expect(result.maxDepth).toBe(2);
  });

  it("let with bindings: values and body all counted", () => {
    const result = validateExprComplexity(
      { let: [{ x: { add: [1, 2] }, y: { sub: [3, 1] } }, { mul: [{ ref: "x" }, { ref: "y" }] }] },
      generous,
    );
    // let(1) + add(1) + sub(1) + mul(1) + ref(1) + ref(1) = 6
    expect(result.operatorCount).toBe(6);
  });

  it("object with fields: each field value counted", () => {
    const result = validateExprComplexity(
      { object: { a: { add: [1, 2] }, b: { sub: [3, 1] } } },
      generous,
    );
    // object(1) + add(1) + sub(1) = 3
    expect(result.operatorCount).toBe(3);
  });

  it("cond with branches: all guards and values counted", () => {
    const result = validateExprComplexity(
      { cond: [[{ eq: [1, 1] }, { add: [1, 2] }], [{ eq: [2, 2] }, { sub: [3, 1] }]] },
      generous,
    );
    // cond(1) + eq(1) + add(1) + eq(1) + sub(1) = 5
    expect(result.operatorCount).toBe(5);
  });

  it("collection ops: body expression counted", () => {
    const result = validateExprComplexity(
      { filter: [{ select: ["context", "arr"] }, "x", { gt: [{ ref: "x" }, 0] }] },
      generous,
    );
    // filter(1) + select(1) + gt(1) + ref(1) = 4
    expect(result.operatorCount).toBe(4);
  });

  it("deeply nested chain", () => {
    let expr: unknown = 0;
    for (let i = 0; i < 10; i++) {
      expr = { add: [expr, 1] };
    }
    const result = validateExprComplexity(expr, generous);
    expect(result.operatorCount).toBe(10);
    expect(result.maxDepth).toBe(10);
  });

  // ─── Limit enforcement ──────────────────────────────────────────────────

  it("exceeds operator count limit: throws with details", () => {
    const operands = Array.from({ length: 10 }, (_, i) => ({ eq: [i, i] }));
    const expr = { and: operands }; // 11 operators
    try {
      validateExprComplexity(expr, { maxOperatorCount: 5, maxDepth: 15 });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExprComplexityExceeded);
      const err = e as ExprComplexityExceeded;
      expect(err.operatorCount).toBe(11);
      expect(err.limit.maxOperatorCount).toBe(5);
    }
  });

  it("exceeds depth limit: throws with details", () => {
    let expr: unknown = 0;
    for (let i = 0; i < 20; i++) {
      expr = { add: [expr, 1] };
    }
    try {
      validateExprComplexity(expr, { maxOperatorCount: 500, maxDepth: 10 });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExprComplexityExceeded);
      const err = e as ExprComplexityExceeded;
      expect(err.maxDepth).toBe(20);
      expect(err.limit.maxDepth).toBe(10);
    }
  });

  it("within limits: returns counts without throwing", () => {
    const result = validateExprComplexity(
      { eq: [{ add: [1, 2] }, 3] },
      { maxOperatorCount: 10, maxDepth: 5 },
    );
    expect(result.operatorCount).toBe(2);
    expect(result.maxDepth).toBe(2);
  });

  it("completes full walk before checking (reports both metrics accurately)", () => {
    // Both limits exceeded
    let expr: unknown = 0;
    for (let i = 0; i < 20; i++) {
      expr = { add: [expr, 1] };
    }
    try {
      validateExprComplexity(expr, { maxOperatorCount: 5, maxDepth: 5 });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as ExprComplexityExceeded;
      // Full walk completed — reports actual totals, not just first violation
      expect(err.operatorCount).toBe(20);
      expect(err.maxDepth).toBe(20);
    }
  });
});
