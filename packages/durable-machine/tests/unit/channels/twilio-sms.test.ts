import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { twilioSmsChannel } from "../../../src/channels/twilio-sms.js";
import type { PromptConfig, SendPromptParams } from "../../../src/types.js";

const ACCOUNT_SID = "AC_test_sid";
const AUTH_TOKEN = "test_auth_token";
const FROM_NUMBER = "+15551234567";
const DEFAULT_RECIPIENT = "+15559876543";

function makeSendParams(prompt: PromptConfig, overrides?: Partial<SendPromptParams>): SendPromptParams {
  return {
    workflowId: "wf-1",
    stateValue: "awaiting",
    prompt,
    context: {},
    ...overrides,
  };
}

describe("twilioSmsChannel()", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ sid: "SM_test_msg_sid", status: "queued" }),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("sendPrompt", () => {
    it("sends choice prompt with numbered options", async () => {
      const channel = twilioSmsChannel({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fromNumber: FROM_NUMBER,
        defaultRecipient: DEFAULT_RECIPIENT,
      });
      const prompt: PromptConfig = {
        type: "choice",
        text: "Pick a color:",
        options: [
          { label: "Red", event: "RED" },
          { label: "Blue", event: "BLUE" },
        ],
      };

      const { handle } = await channel.sendPrompt(makeSendParams(prompt));

      expect(handle).toEqual({
        messageSid: "SM_test_msg_sid",
        to: DEFAULT_RECIPIENT,
        workflowId: "wf-1",
      });

      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain(`/Accounts/${ACCOUNT_SID}/Messages.json`);
      expect(opts.headers.Authorization).toContain("Basic");

      const body = new URLSearchParams(opts.body);
      expect(body.get("To")).toBe(DEFAULT_RECIPIENT);
      expect(body.get("From")).toBe(FROM_NUMBER);
      expect(body.get("Body")).toContain("1 for Red");
      expect(body.get("Body")).toContain("2 for Blue");
    });

    it("sends confirm prompt with YES/NO instructions", async () => {
      const channel = twilioSmsChannel({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fromNumber: FROM_NUMBER,
        defaultRecipient: DEFAULT_RECIPIENT,
      });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "Confirm deployment?",
        confirmEvent: "YES",
        cancelEvent: "NO",
      };

      await channel.sendPrompt(makeSendParams(prompt));

      const body = new URLSearchParams(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.get("Body")).toContain("Reply YES to confirm, NO to cancel");
    });

    it("sends text_input prompt", async () => {
      const channel = twilioSmsChannel({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fromNumber: FROM_NUMBER,
        defaultRecipient: DEFAULT_RECIPIENT,
      });
      const prompt: PromptConfig = {
        type: "text_input",
        text: "Enter reason:",
        event: "REASON",
      };

      await channel.sendPrompt(makeSendParams(prompt));

      const body = new URLSearchParams(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.get("Body")).toContain("Reply with your answer");
    });

    it("sends form prompt with fallback message", async () => {
      const channel = twilioSmsChannel({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fromNumber: FROM_NUMBER,
        defaultRecipient: DEFAULT_RECIPIENT,
      });
      const prompt: PromptConfig = {
        type: "form",
        text: "Fill out details:",
        event: "SUBMIT",
        fields: [{ name: "name", label: "Name", type: "text" }],
      };

      await channel.sendPrompt(makeSendParams(prompt));

      const body = new URLSearchParams(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.get("Body")).toContain("not supported via SMS");
    });

    it("resolves recipient from prompt.recipient", async () => {
      const channel = twilioSmsChannel({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fromNumber: FROM_NUMBER,
      });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "OK?",
        confirmEvent: "YES",
        cancelEvent: "NO",
        recipient: "+15550001111",
      };

      await channel.sendPrompt(makeSendParams(prompt));

      const body = new URLSearchParams(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.get("To")).toBe("+15550001111");
    });

    it("resolves recipient from function", async () => {
      const channel = twilioSmsChannel({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fromNumber: FROM_NUMBER,
      });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "OK?",
        confirmEvent: "YES",
        cancelEvent: "NO",
        recipient: ({ context }) => context.phone as string,
      };

      await channel.sendPrompt(
        makeSendParams(prompt, { context: { phone: "+15552223333" } }),
      );

      const body = new URLSearchParams(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.get("To")).toBe("+15552223333");
    });

    it("throws when no recipient and no default", async () => {
      const channel = twilioSmsChannel({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fromNumber: FROM_NUMBER,
      });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "OK?",
        confirmEvent: "YES",
        cancelEvent: "NO",
      };

      await expect(channel.sendPrompt(makeSendParams(prompt))).rejects.toThrow(
        "No recipient specified",
      );
    });

    it("resolves dynamic text from function", async () => {
      const channel = twilioSmsChannel({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fromNumber: FROM_NUMBER,
        defaultRecipient: DEFAULT_RECIPIENT,
      });
      const prompt: PromptConfig = {
        type: "confirm",
        text: ({ context }) => `Approve order ${context.orderId}?`,
        confirmEvent: "YES",
        cancelEvent: "NO",
      };

      await channel.sendPrompt(makeSendParams(prompt, { context: { orderId: "O-42" } }));

      const body = new URLSearchParams(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.get("Body")).toContain("Approve order O-42?");
    });

    it("throws on Twilio API error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ message: "Invalid To number" }),
      });

      const channel = twilioSmsChannel({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fromNumber: FROM_NUMBER,
        defaultRecipient: DEFAULT_RECIPIENT,
      });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "OK?",
        confirmEvent: "YES",
        cancelEvent: "NO",
      };

      await expect(channel.sendPrompt(makeSendParams(prompt))).rejects.toThrow(
        "Invalid To number",
      );
    });
  });

  describe("resolvePrompt", () => {
    it("sends a follow-up SMS", async () => {
      const channel = twilioSmsChannel({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fromNumber: FROM_NUMBER,
      });

      await channel.resolvePrompt!({
        handle: { messageSid: "SM_123", to: "+15559876543", workflowId: "wf-1" },
        event: { type: "APPROVE" },
        newStateValue: "approved",
      });

      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const body = new URLSearchParams(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.get("To")).toBe("+15559876543");
      expect(body.get("Body")).toContain("Resolved: APPROVE");
    });
  });
});
