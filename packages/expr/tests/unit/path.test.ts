import { describe, it, expect } from "vitest";
import { selectPath } from "../../src/path.js";
import { createScope } from "../../src/types.js";

describe("selectPath", () => {
  it("navigates static keys", () => {
    const scope = createScope({ context: { name: "Alice" } });
    expect(selectPath(["context", "name"], scope)).toBe("Alice");
  });

  it("navigates nested keys", () => {
    const scope = createScope({ context: { aus: { "au-1": { hasCompleted: true } } } });
    expect(selectPath(["context", "aus", "au-1", "hasCompleted"], scope)).toBe(true);
  });

  it("returns undefined for missing paths", () => {
    const scope = createScope({ context: {} });
    expect(selectPath(["context", "missing", "deep"], scope)).toBeUndefined();
  });

  it("navigates event fields", () => {
    const scope = createScope({ context: {}, event: { type: "PASSED", score: 85 } });
    expect(selectPath(["event", "type"], scope)).toBe("PASSED");
    expect(selectPath(["event", "score"], scope)).toBe(85);
  });

  it("navigates with dynamic param key", () => {
    const scope = createScope({
      context: { aus: { "au-1": { hasPassed: true } } },
      params: { auId: "au-1" },
    });
    expect(selectPath(["context", "aus", { param: "auId" }, "hasPassed"], scope)).toBe(true);
  });

  it("navigates with dynamic ref key", () => {
    const scope = createScope({ context: { items: { x: 42 } } });
    scope.bindings = { key: "x" };
    expect(selectPath(["context", "items", { ref: "key" }], scope)).toBe(42);
  });

  it("returns undefined for null intermediate", () => {
    const scope = createScope({ context: { x: null } });
    expect(selectPath(["context", "x", "y"], scope)).toBeUndefined();
  });

  it("resolves binding as root", () => {
    const scope = createScope({ context: {} });
    scope.bindings = { current: { hasPassed: true } };
    expect(selectPath(["current", "hasPassed"], scope)).toBe(true);
  });
});
