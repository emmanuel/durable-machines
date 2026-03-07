import { describe, it, expect } from "vitest";
import {
  isRef,
  resolveRef,
  resolveExpressions,
  resolveTemplate,
} from "../../../src/definition/expressions.js";

describe("isRef", () => {
  it("returns true for $ref objects", () => {
    expect(isRef({ $ref: "context.x" })).toBe(true);
  });

  it("returns false for objects without $ref", () => {
    expect(isRef({ other: 1 })).toBe(false);
  });

  it("returns false for strings", () => {
    expect(isRef("string")).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isRef([{ $ref: "context.x" }])).toBe(false);
  });

  it("returns false for null", () => {
    expect(isRef(null)).toBe(false);
  });
});

describe("resolveRef", () => {
  it("resolves context values", () => {
    expect(resolveRef("context.total", { context: { total: 50 } })).toBe(50);
  });

  it("resolves nested context paths", () => {
    expect(
      resolveRef("context.nested.deep", {
        context: { nested: { deep: "v" } },
      }),
    ).toBe("v");
  });

  it("returns undefined for missing paths", () => {
    expect(resolveRef("context.missing", { context: {} })).toBe(undefined);
  });

  it("resolves event.type", () => {
    expect(
      resolveRef("event.type", {
        context: {},
        event: { type: "PAY" },
      }),
    ).toBe("PAY");
  });

  it("resolves input values", () => {
    expect(
      resolveRef("input.orderId", {
        context: {},
        input: { orderId: "o1" },
      }),
    ).toBe("o1");
  });

  it("returns undefined for invalid prefix", () => {
    expect(resolveRef("invalid.path", { context: {} })).toBe(undefined);
  });

  it("returns the entire scope root when no dot path", () => {
    const ctx = { a: 1 };
    expect(resolveRef("context", { context: ctx })).toBe(ctx);
  });
});

describe("resolveExpressions", () => {
  const scope = {
    context: { total: 50, name: "Alice" },
    event: { type: "PAY" },
  };

  it("resolves $ref objects to their values", () => {
    expect(resolveExpressions({ $ref: "context.total" }, scope)).toBe(50);
  });

  it("recursively resolves nested objects", () => {
    const input = {
      amount: { $ref: "context.total" },
      label: "static",
    };
    expect(resolveExpressions(input, scope)).toEqual({
      amount: 50,
      label: "static",
    });
  });

  it("resolves arrays with mixed $ref and literal elements", () => {
    const input = [{ $ref: "context.total" }, "literal", 42];
    expect(resolveExpressions(input, scope)).toEqual([50, "literal", 42]);
  });

  it("leaves primitives alone", () => {
    expect(resolveExpressions(42, scope)).toBe(42);
    expect(resolveExpressions(true, scope)).toBe(true);
    expect(resolveExpressions(null, scope)).toBe(null);
  });

  it("resolves template strings", () => {
    expect(resolveExpressions("Hello {{ context.name }}", scope)).toBe(
      "Hello Alice",
    );
  });

  it("passes through plain strings", () => {
    expect(resolveExpressions("no expressions", scope)).toBe("no expressions");
  });
});

describe("resolveTemplate", () => {
  it("interpolates context values", () => {
    expect(
      resolveTemplate("Ship {{ context.orderId }}", {
        context: { orderId: "o1" },
      }),
    ).toBe("Ship o1");
  });

  it("passes through strings without expressions", () => {
    expect(
      resolveTemplate("No expressions here", { context: {} }),
    ).toBe("No expressions here");
  });

  it("resolves missing values to empty string", () => {
    expect(
      resolveTemplate("{{ context.missing }}", { context: {} }),
    ).toBe("");
  });

  it("handles multiple expressions", () => {
    expect(
      resolveTemplate("{{ context.a }} and {{ context.b }}", {
        context: { a: "X", b: "Y" },
      }),
    ).toBe("X and Y");
  });

  it("handles whitespace in expression braces", () => {
    expect(
      resolveTemplate("{{  context.x  }}", { context: { x: "val" } }),
    ).toBe("val");
  });
});
