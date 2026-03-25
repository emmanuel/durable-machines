import { describe, it, expect } from "vitest";
import { createScope, deductStep, StepBudgetExceeded } from "../../src/types.js";
import { evaluate } from "../../src/evaluate.js";
import { compile } from "../../src/compile.js";
import { applyTransforms } from "../../src/transforms.js";

// ─── deductStep helper ──────────────────────────────────────────────────────

describe("deductStep", () => {
  it("no-ops when budget is undefined", () => {
    const scope = createScope({ context: {} });
    expect(() => deductStep(scope)).not.toThrow();
  });

  it("decrements remaining", () => {
    const scope = createScope({ context: {}, budget: { remaining: 5 } });
    deductStep(scope);
    expect(scope.budget!.remaining).toBe(4);
  });

  it("throws StepBudgetExceeded when remaining hits 0", () => {
    const scope = createScope({ context: {}, budget: { remaining: 0 } });
    expect(() => deductStep(scope)).toThrow(StepBudgetExceeded);
  });
});

// ─── createScope budget ─────────────────────────────────────────────────────

describe("createScope with budget", () => {
  it("carries budget through", () => {
    const scope = createScope({ context: {}, budget: { remaining: 100 } });
    expect(scope.budget).toEqual({ remaining: 100 });
  });

  it("budget is undefined by default", () => {
    const scope = createScope({ context: {} });
    expect(scope.budget).toBeUndefined();
  });
});

// ─── evaluate() step budget ─────────────────────────────────────────────────

describe("evaluate — step budget", () => {
  it("simple expression consumes steps", () => {
    const scope = createScope({ context: { x: 1 }, budget: { remaining: 100 } });
    evaluate({ select: ["context", "x"] }, scope);
    expect(scope.budget!.remaining).toBeLessThan(100);
  });

  it("throws StepBudgetExceeded when budget exhausted", () => {
    const scope = createScope({ context: { x: 1 }, budget: { remaining: 1 } });
    // eq evaluates two sub-expressions + itself = needs more than 1 step
    expect(() => evaluate({ eq: [1, 1] }, scope)).toThrow(StepBudgetExceeded);
  });

  it("budget of 0 throws immediately", () => {
    const scope = createScope({ context: {}, budget: { remaining: 0 } });
    expect(() => evaluate(42, scope)).toThrow(StepBudgetExceeded);
  });

  it("unlimited when budget is absent", () => {
    const scope = createScope({ context: { x: 1 } });
    // No budget — should not throw regardless of complexity
    expect(() => evaluate({ eq: [{ add: [1, 2] }, 3] }, scope)).not.toThrow();
  });

  it("budget exactly sufficient completes without throwing", () => {
    // A literal needs 1 step (the evaluate() entry)
    const scope = createScope({ context: {}, budget: { remaining: 1 } });
    expect(() => evaluate(42, scope)).not.toThrow();
    expect(scope.budget!.remaining).toBe(0);
  });

  it("budget shared across nested let scopes", () => {
    const scope = createScope({ context: {}, budget: { remaining: 1000 } });
    evaluate({ let: [{ x: 1, y: 2 }, { add: ["@.x", "@.y"] }] }, scope);
    // Budget should have been decremented by the let + bindings + body
    expect(scope.budget!.remaining).toBeLessThan(1000);
  });

  it("where predicate consumes steps per entry", () => {
    const items: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) items[`k${i}`] = { val: i };
    const scope = createScope({ context: { items }, budget: { remaining: 1000 } });
    evaluate({ select: ["context", "items", { where: { eq: ["val", 999] } }] }, scope);
    // Each entry tested should cost at least 1 step
    expect(scope.budget!.remaining).toBeLessThan(900);
  });

  it("collection iteration consumes steps per element", () => {
    const scope = createScope({
      context: { arr: [1, 2, 3, 4, 5] },
      budget: { remaining: 1000 },
    });
    evaluate({ pipe: [{ select: ["context", "arr"] }, { map: ["x", { add: ["@.x", 1] }] }] }, scope);
    expect(scope.budget!.remaining).toBeLessThan(990);
  });

  it("deeply nested expression exhausts budget", () => {
    // Build a deeply nested add chain: add(add(add(..., 1), 1), 1)
    let expr: unknown = 0;
    for (let i = 0; i < 50; i++) {
      expr = { add: [expr, 1] };
    }
    const scope = createScope({ context: {}, budget: { remaining: 10 } });
    expect(() => evaluate(expr, scope)).toThrow(StepBudgetExceeded);
  });
});

// ─── compile() step budget ──────────────────────────────────────────────────

describe("compile — step budget", () => {
  it("compiled expression consumes steps at runtime", () => {
    const fn = compile({ eq: [1, 1] });
    const scope = createScope({ context: {}, budget: { remaining: 100 } });
    fn(scope);
    expect(scope.budget!.remaining).toBeLessThan(100);
  });

  it("throws StepBudgetExceeded when budget exhausted in compiled path", () => {
    const fn = compile({ eq: [{ add: [1, 2] }, 3] });
    const scope = createScope({ context: {}, budget: { remaining: 1 } });
    expect(() => fn(scope)).toThrow(StepBudgetExceeded);
  });

  it("compiled where path step exhausts budget on large collection", () => {
    const items: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) items[`k${i}`] = { val: i };
    const fn = compile({ select: ["context", "items", { where: { eq: ["val", 999] } }] });
    const scope = createScope({ context: { items }, budget: { remaining: 5 } });
    expect(() => fn(scope)).toThrow(StepBudgetExceeded);
  });

  it("compiled collection ops consume steps per element", () => {
    const fn = compile({ pipe: [{ select: ["context", "arr"] }, { filter: ["x", { gt: ["@.x", 2] }] }] });
    const scope = createScope({
      context: { arr: [1, 2, 3, 4, 5] },
      budget: { remaining: 1000 },
    });
    fn(scope);
    expect(scope.budget!.remaining).toBeLessThan(990);
  });

  it("unlimited when budget is absent", () => {
    const fn = compile({ eq: [{ add: [1, 2] }, 3] });
    const scope = createScope({ context: {} });
    expect(() => fn(scope)).not.toThrow();
  });

  it("deeply nested compiled expression exhausts budget", () => {
    let expr: unknown = 0;
    for (let i = 0; i < 50; i++) {
      expr = { add: [expr, 1] };
    }
    const fn = compile(expr);
    const scope = createScope({ context: {}, budget: { remaining: 10 } });
    expect(() => fn(scope)).toThrow(StepBudgetExceeded);
  });
});

// ─── transforms step budget ─────────────────────────────────────────────────

describe("transforms — step budget", () => {
  it("transform fan-out consumes steps per matching entry", () => {
    const items: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) items[`k${i}`] = { val: i, score: 0 };
    const scope = createScope({ context: { items }, budget: { remaining: 1000 } });
    applyTransforms(
      { items },
      [{ path: ["items", { where: { gt: ["val", -1] } }, "score"], set: 100 }],
      scope,
    );
    // All 50 entries match, each fan-out should cost steps
    expect(scope.budget!.remaining).toBeLessThan(950);
  });

  it("throws StepBudgetExceeded on large fan-out with tight budget", () => {
    const items: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) items[`k${i}`] = { val: i, score: 0 };
    const scope = createScope({ context: { items }, budget: { remaining: 5 } });
    expect(() =>
      applyTransforms(
        { items },
        [{ path: ["items", { where: { gt: ["val", -1] } }, "score"], set: 100 }],
        scope,
      ),
    ).toThrow(StepBudgetExceeded);
  });
});
