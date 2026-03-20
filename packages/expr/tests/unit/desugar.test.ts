import { describe, it, expect } from "vitest";
import { parseDollarPath, parseParamSugar, parseRefSugar } from "../../src/desugar.js";

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

describe("parseParamSugar", () => {
  it("parses simple param name", () => {
    expect(parseParamSugar("%.auId")).toEqual({ param: "auId" });
  });

  it("parses hyphenated param name", () => {
    expect(parseParamSugar("%.foo-bar")).toEqual({ param: "foo-bar" });
  });

  it("throws on empty name", () => {
    expect(() => parseParamSugar("%.")).toThrow("Invalid param sugar");
  });

  it("throws on dots in name", () => {
    expect(() => parseParamSugar("%.foo.bar")).toThrow("Invalid param sugar");
  });
});

describe("parseRefSugar", () => {
  it("parses simple ref name", () => {
    expect(parseRefSugar("@.score")).toEqual({ ref: "score" });
  });

  it("parses hyphenated ref name", () => {
    expect(parseRefSugar("@.my-binding")).toEqual({ ref: "my-binding" });
  });

  it("throws on empty name", () => {
    expect(() => parseRefSugar("@.")).toThrow("Invalid ref sugar");
  });

  it("throws on dots in name", () => {
    expect(() => parseRefSugar("@.foo.bar")).toThrow("Invalid ref sugar");
  });
});
