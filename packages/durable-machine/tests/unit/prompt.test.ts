import { describe, it, expect } from "vitest";
import { prompt, getPromptConfig, getPromptEvents } from "../../src/prompt.js";
import type { PromptConfig } from "../../src/types.js";

describe("prompt()", () => {
  it("supports dynamic text via function", () => {
    const config: PromptConfig = {
      type: "choice",
      text: ({ context }) => `Order #${context.orderId}`,
      options: [{ label: "OK", event: "OK" }],
    };
    const result = prompt(config);
    const text = result.meta["xstate-durable"].prompt.text;
    expect(typeof text).toBe("function");
    if (typeof text === "function") {
      expect(text({ context: { orderId: "123" } })).toBe("Order #123");
    }
  });

  it("includes effects in meta when provided", () => {
    const config: PromptConfig = {
      type: "choice",
      text: "Pick",
      options: [{ label: "A", event: "A" }],
    };
    const effects = [{ type: "webhook", url: "https://example.com" }];
    const result = prompt(config, { effects });
    const meta = result.meta["xstate-durable"];
    expect(meta.durable).toBe(true);
    expect(meta.prompt).toEqual(config);
    expect(meta.effects).toEqual(effects);
    expect(meta.compiledEffects).toHaveLength(1);
    expect(typeof meta.compiledEffects[0]).toBe("function");
  });

  it("omits effects when not provided", () => {
    const config: PromptConfig = {
      type: "choice",
      text: "Pick",
      options: [{ label: "A", event: "A" }],
    };
    const result = prompt(config);
    expect("effects" in result.meta["xstate-durable"]).toBe(false);
  });
});

describe("getPromptConfig()", () => {
  it("returns prompt config from metadata", () => {
    const config: PromptConfig = {
      type: "choice",
      text: "Pick one",
      options: [{ label: "A", event: "A" }],
    };
    const meta = { "xstate-durable": { prompt: config } };
    expect(getPromptConfig(meta)).toEqual(config);
  });

});

describe("getPromptEvents()", () => {
  it("extracts events from choice prompt", () => {
    const config: PromptConfig = {
      type: "choice",
      text: "Pick",
      options: [
        { label: "A", event: "APPROVE" },
        { label: "R", event: "REJECT" },
        { label: "E", event: "ESCALATE" },
      ],
    };
    expect(getPromptEvents(config)).toEqual(["APPROVE", "REJECT", "ESCALATE"]);
  });

  it("extracts events from confirm prompt", () => {
    const config: PromptConfig = {
      type: "confirm",
      text: "OK?",
      confirmEvent: "YES",
      cancelEvent: "NO",
    };
    expect(getPromptEvents(config)).toEqual(["YES", "NO"]);
  });

  it("extracts event from text_input prompt", () => {
    const config: PromptConfig = {
      type: "text_input",
      text: "Enter reason",
      event: "SUBMIT_REASON",
    };
    expect(getPromptEvents(config)).toEqual(["SUBMIT_REASON"]);
  });

  it("extracts event from form prompt", () => {
    const config: PromptConfig = {
      type: "form",
      text: "Fill the form",
      fields: [{ name: "name", label: "Name", type: "text" }],
      event: "SUBMIT_FORM",
    };
    expect(getPromptEvents(config)).toEqual(["SUBMIT_FORM"]);
  });
});
