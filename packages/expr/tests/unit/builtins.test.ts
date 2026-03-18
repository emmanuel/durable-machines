import { describe, it, expect } from "vitest";
import { evaluate } from "../../src/evaluate.js";
import { createScope } from "../../src/types.js";
import { defaultBuiltins, createBuiltinRegistry } from "../../src/builtins.js";

describe("evaluate — fn (builtins)", () => {
  it("uuid returns a UUID string", () => {
    const scope = createScope({ context: {} });
    const result = evaluate({ fn: ["uuid"] }, scope, defaultBuiltins);
    expect(typeof result).toBe("string");
    expect(result).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("now returns a timestamp number", () => {
    const scope = createScope({ context: {} });
    const result = evaluate({ fn: ["now"] }, scope, defaultBuiltins);
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(0);
  });

  it("fn with args: passes evaluated args", () => {
    const scope = createScope({ context: {} });
    const builtins = createBuiltinRegistry({
      add3: (a: unknown, b: unknown, c: unknown) => (a as number) + (b as number) + (c as number),
    });
    expect(evaluate({ fn: ["add3", 1, 2, 3] }, scope, builtins)).toBe(6);
  });

  it("fn with args: args are evaluated as expressions", () => {
    const scope = createScope({ context: { x: 10 } });
    const builtins = createBuiltinRegistry({
      double: (n: unknown) => (n as number) * 2,
    });
    expect(evaluate(
      { fn: ["double", { select: ["context", "x"] }] },
      scope,
      builtins,
    )).toBe(20);
  });

  it("iso8601Duration computes duration between two ISO timestamps", () => {
    const scope = createScope({ context: {} });
    const result = evaluate(
      { fn: ["iso8601Duration", "2025-01-01T00:00:00Z", "2025-01-01T01:01:01Z"] },
      scope,
      defaultBuiltins,
    );
    expect(result).toBe("PT3661S");
  });

  it("iso8601Duration returns PT0S when end is before start", () => {
    const scope = createScope({ context: {} });
    const result = evaluate(
      { fn: ["iso8601Duration", "2025-01-01T01:00:00Z", "2025-01-01T00:00:00Z"] },
      scope,
      defaultBuiltins,
    );
    expect(result).toBe("PT0S");
  });

  it("unknown builtin returns undefined", () => {
    const scope = createScope({ context: {} });
    expect(evaluate({ fn: ["unknown"] }, scope, defaultBuiltins)).toBeUndefined();
  });

  it("createBuiltinRegistry merges with defaults", () => {
    const builtins = createBuiltinRegistry({ custom: () => "hi" });
    expect(builtins.uuid).toBeDefined();
    expect(builtins.now).toBeDefined();
    expect(builtins.custom).toBeDefined();
  });
});

describe("evaluate — fn (str builtin)", () => {
  it("str with string args concatenates them", () => {
    const scope = createScope({ context: {} });
    expect(
      evaluate({ fn: ["str", "hello", " ", "world"] }, scope, defaultBuiltins),
    ).toBe("hello world");
  });

  it("str with numbers coerces to string", () => {
    const scope = createScope({ context: {} });
    expect(
      evaluate({ fn: ["str", "count: ", 42] }, scope, defaultBuiltins),
    ).toBe("count: 42");
  });

  it("str with null treats null as empty string", () => {
    const scope = createScope({ context: {} });
    expect(
      evaluate({ fn: ["str", "a", null, "b"] }, scope, defaultBuiltins),
    ).toBe("ab");
  });

  it("str with undefined treats undefined as empty string", () => {
    const scope = createScope({ context: {} });
    expect(
      evaluate({ fn: ["str", undefined, "x"] }, scope, defaultBuiltins),
    ).toBe("x");
  });

  it("str with no args returns empty string", () => {
    const scope = createScope({ context: {} });
    expect(
      evaluate({ fn: ["str"] }, scope, defaultBuiltins),
    ).toBe("");
  });

  it("str with select arg evaluates nested expressions", () => {
    const scope = createScope({ context: { name: "Alice" } });
    expect(
      evaluate(
        { fn: ["str", "Hello ", { select: ["context", "name"] }] },
        scope,
        defaultBuiltins,
      ),
    ).toBe("Hello Alice");
  });
});
