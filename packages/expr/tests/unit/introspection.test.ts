import { describe, it, expect } from "vitest";
import { isExprOperator } from "../../src/introspection.js";

describe("isExprOperator", () => {
  it("returns true for { select: [...] }", () => {
    expect(isExprOperator({ select: ["context", "x"] })).toBe(true);
  });

  it("returns true for { fn: [...] }", () => {
    expect(isExprOperator({ fn: ["str", "hello"] })).toBe(true);
  });

  it("returns true for { object: {...} }", () => {
    expect(isExprOperator({ object: { a: 1 } })).toBe(true);
  });

  it("returns true for { eq: [...] }", () => {
    expect(isExprOperator({ eq: [1, 1] })).toBe(true);
  });

  it("returns true for { and: [...] }", () => {
    expect(isExprOperator({ and: [true] })).toBe(true);
  });

  it("returns false for { method: 'GET' } (unrecognized key)", () => {
    expect(isExprOperator({ method: "GET" })).toBe(false);
  });

  it("returns false for { $ref: 'context.x' }", () => {
    expect(isExprOperator({ $ref: "context.x" })).toBe(false);
  });

  it("returns false for { url: 'http://...' }", () => {
    expect(isExprOperator({ url: "http://example.com" })).toBe(false);
  });

  it("returns false for number primitive", () => {
    expect(isExprOperator(42)).toBe(false);
  });

  it("returns false for string primitive", () => {
    expect(isExprOperator("hello")).toBe(false);
  });

  it("returns false for boolean primitive", () => {
    expect(isExprOperator(true)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isExprOperator(null)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isExprOperator([1, 2, 3])).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isExprOperator(undefined)).toBe(false);
  });
});
