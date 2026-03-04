import { describe, it, expect } from "vitest";
import { prompt, getPromptConfig, getPromptEvents } from "../../src/prompt.js";
import type { PromptConfig } from "../../src/types.js";

describe("prompt()", () => {
  it("returns meta with prompt config for choice type", () => {
    const config: PromptConfig = {
      type: "choice",
      text: "Approve this request?",
      options: [
        { label: "Approve", event: "APPROVE", style: "primary" },
        { label: "Reject", event: "REJECT", style: "danger" },
      ],
    };
    const result = prompt(config);
    expect(result).toEqual({
      meta: { "xstate-dbos": { quiescent: true, prompt: config } },
    });
  });

  it("returns meta with prompt config for confirm type", () => {
    const config: PromptConfig = {
      type: "confirm",
      text: "Ship this order?",
      confirmEvent: "SHIP",
      cancelEvent: "CANCEL",
    };
    const result = prompt(config);
    expect(result.meta["xstate-dbos"].prompt).toEqual(config);
  });

  it("supports dynamic text via function", () => {
    const config: PromptConfig = {
      type: "choice",
      text: ({ context }) => `Order #${context.orderId}`,
      options: [{ label: "OK", event: "OK" }],
    };
    const result = prompt(config);
    const text = result.meta["xstate-dbos"].prompt.text;
    expect(typeof text).toBe("function");
    if (typeof text === "function") {
      expect(text({ context: { orderId: "123" } })).toBe("Order #123");
    }
  });
});

describe("getPromptConfig()", () => {
  it("returns prompt config from metadata", () => {
    const config: PromptConfig = {
      type: "choice",
      text: "Pick one",
      options: [{ label: "A", event: "A" }],
    };
    const meta = { "xstate-dbos": { prompt: config } };
    expect(getPromptConfig(meta)).toEqual(config);
  });

  it("returns null when no prompt in metadata", () => {
    const meta = { "xstate-dbos": { quiescent: true } };
    expect(getPromptConfig(meta)).toBeNull();
  });

  it("returns null for undefined metadata", () => {
    expect(getPromptConfig(undefined)).toBeNull();
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
