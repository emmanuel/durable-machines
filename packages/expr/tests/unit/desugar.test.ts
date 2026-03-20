import { describe, it, expect } from "vitest";
import { parseDollarPath } from "../../src/desugar.js";

describe("parseDollarPath", () => {
  it("parses single-segment path", () => {
    expect(parseDollarPath("$.context")).toEqual({ select: ["context"] });
  });

  it("parses two-segment path", () => {
    expect(parseDollarPath("$.context.count")).toEqual({ select: ["context", "count"] });
  });

  it("parses deeply nested path", () => {
    expect(parseDollarPath("$.a.b.c.d")).toEqual({ select: ["a", "b", "c", "d"] });
  });

  it("parses binding name", () => {
    expect(parseDollarPath("$.myBinding")).toEqual({ select: ["myBinding"] });
  });

  it("throws on empty path (just $.)", () => {
    expect(() => parseDollarPath("$.")).toThrow();
  });

  it("throws on empty segment (double dot)", () => {
    expect(() => parseDollarPath("$.context..foo")).toThrow();
  });

  it("throws on trailing dot", () => {
    expect(() => parseDollarPath("$.context.")).toThrow();
  });

  it("parses path with hyphens and numbers", () => {
    expect(parseDollarPath("$.context.au-1.score")).toEqual({ select: ["context", "au-1", "score"] });
  });
});
