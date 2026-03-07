import { describe, it, expect } from "vitest";
import { createEffectHandlers, getEffectsConfig } from "../../src/effects.js";

describe("createEffectHandlers()", () => {
  it("creates a registry from a record of handlers", () => {
    const handler = async () => {};
    const registry = createEffectHandlers({ webhook: handler });
    expect(registry.handlers.get("webhook")).toBe(handler);
    expect(registry.handlers.size).toBe(1);
  });

  it("creates an empty registry from empty record", () => {
    const registry = createEffectHandlers({});
    expect(registry.handlers.size).toBe(0);
  });

  it("returns a frozen registry", () => {
    const registry = createEffectHandlers({
      webhook: async () => {},
    });
    expect(Object.isFrozen(registry)).toBe(true);
  });
});

describe("getEffectsConfig()", () => {
  it("returns effect configs from metadata", () => {
    const effects = [{ type: "webhook", url: "https://example.com" }];
    const meta = { "xstate-durable": { effects } };
    expect(getEffectsConfig(meta)).toEqual(effects);
  });

  it("returns null when no effects present", () => {
    const meta = { "xstate-durable": { durable: true } };
    expect(getEffectsConfig(meta)).toBeNull();
  });

  it("returns null for undefined meta", () => {
    expect(getEffectsConfig(undefined)).toBeNull();
  });

  it("returns null for empty effects array", () => {
    const meta = { "xstate-durable": { effects: [] } };
    expect(getEffectsConfig(meta)).toBeNull();
  });
});
