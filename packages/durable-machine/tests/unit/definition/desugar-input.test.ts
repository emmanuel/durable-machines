import { describe, it, expect } from "vitest";
import { desugarInput, compileInput } from "../../../src/definition/desugar-input.js";
import { defaultBuiltins } from "@durable-machines/expr";

describe("desugarInput", () => {
  it("converts $ref to select with dotted path", () => {
    expect(desugarInput({ $ref: "context.x.y" })).toEqual({
      select: ["context", "x", "y"],
    });
  });

  it("converts $ref with single segment", () => {
    expect(desugarInput({ $ref: "context" })).toEqual({
      select: ["context"],
    });
  });

  it("converts template string with interpolation to str fn call", () => {
    expect(desugarInput("Hello {{ context.name }}")).toEqual({
      fn: ["str", "Hello ", { select: ["context", "name"] }],
    });
  });

  it("converts single interpolation directly to select (no str wrapper)", () => {
    expect(desugarInput("{{ context.x }}")).toEqual({
      select: ["context", "x"],
    });
  });

  it("passes through plain strings without templates", () => {
    expect(desugarInput("no templates")).toBe("no templates");
  });

  it("passes through primitives", () => {
    expect(desugarInput(42)).toBe(42);
    expect(desugarInput(true)).toBe(true);
    expect(desugarInput(null)).toBe(null);
  });

  it("passes through expr operator objects (select)", () => {
    expect(desugarInput({ select: ["context", "a"] })).toEqual({
      select: ["context", "a"],
    });
  });

  it("passes through expr operator objects (fn)", () => {
    expect(desugarInput({ fn: ["uuid"] })).toEqual({ fn: ["uuid"] });
  });

  it("wraps plain objects in { object: ... } with recursive desugaring", () => {
    expect(
      desugarInput({ total: { $ref: "context.total" }, currency: "USD" }),
    ).toEqual({
      object: { total: { select: ["context", "total"] }, currency: "USD" },
    });
  });

  it("wraps plain objects with mixed $ref and literals", () => {
    expect(
      desugarInput({ method: "GET", url: { $ref: "context.url" } }),
    ).toEqual({
      object: { method: "GET", url: { select: ["context", "url"] } },
    });
  });

  it("passes through arrays", () => {
    expect(desugarInput([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("compileInput", () => {
  it("resolves $ref paths at runtime", () => {
    const fn = compileInput({ $ref: "context.total" });
    expect(fn({ context: { total: 99 } })).toBe(99);
  });

  it("resolves template strings at runtime", () => {
    const fn = compileInput("Hello {{ context.name }}", defaultBuiltins);
    expect(fn({ context: { name: "Alice" } })).toBe("Hello Alice");
  });

  it("resolves plain objects with nested $ref at runtime", () => {
    const fn = compileInput({ total: { $ref: "context.total" }, currency: "USD" });
    expect(fn({ context: { total: 42 } })).toEqual({ total: 42, currency: "USD" });
  });

  it("resolves expr select pass-through at runtime", () => {
    const fn = compileInput({ select: ["context", "name"] });
    expect(fn({ context: { name: "Bob" } })).toBe("Bob");
  });

  it("resolves literals at runtime", () => {
    const fn = compileInput(42);
    expect(fn({ context: {} })).toBe(42);
  });

  it("resolves nested dotted $ref paths at runtime", () => {
    const fn = compileInput({ $ref: "context.nested.deep" });
    expect(fn({ context: { nested: { deep: "v" } } })).toBe("v");
  });
});
