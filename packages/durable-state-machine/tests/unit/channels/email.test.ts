import { describe, it, expect, vi } from "vitest";
import { emailChannel, signActionLink } from "../../../src/channels/email.js";
import type { PromptConfig, SendPromptParams } from "../../../src/types.js";

const SIGNING_SECRET = "test-secret-key";
const CALLBACK_URL = "https://app.example.com/actions";

function makeSendParams(prompt: PromptConfig, overrides?: Partial<SendPromptParams>): SendPromptParams {
  return {
    workflowId: "wf-1",
    stateValue: "awaiting",
    prompt,
    context: {},
    ...overrides,
  };
}

describe("emailChannel()", () => {
  const sendEmail = vi.fn().mockResolvedValue(undefined);

  describe("sendPrompt", () => {
    it("sends choice prompt with action link buttons", async () => {
      const channel = emailChannel({
        sendEmail,
        callbackUrl: CALLBACK_URL,
        signingSecret: SIGNING_SECRET,
        defaultRecipient: "user@example.com",
      });
      const prompt: PromptConfig = {
        type: "choice",
        text: "Approve the deployment?",
        options: [
          { label: "Approve", event: "APPROVE", style: "primary" },
          { label: "Reject", event: "REJECT", style: "danger" },
        ],
      };

      const { handle } = await channel.sendPrompt(makeSendParams(prompt));

      expect(handle).toEqual({ to: "user@example.com", workflowId: "wf-1" });
      expect(sendEmail).toHaveBeenCalledOnce();

      const call = sendEmail.mock.calls[0][0];
      expect(call.to).toBe("user@example.com");
      expect(call.subject).toBe("Approve the deployment?");
      expect(call.html).toContain("Approve");
      expect(call.html).toContain("Reject");
      expect(call.html).toContain(CALLBACK_URL);
      expect(call.html).toContain("workflowId=wf-1");
      expect(call.html).toContain("event=APPROVE");
      expect(call.html).toContain("event=REJECT");
    });

    it("sends confirm prompt with two buttons", async () => {
      sendEmail.mockClear();
      const channel = emailChannel({
        sendEmail,
        callbackUrl: CALLBACK_URL,
        signingSecret: SIGNING_SECRET,
        defaultRecipient: "user@example.com",
      });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "Confirm action?",
        confirmEvent: "YES",
        cancelEvent: "NO",
      };

      await channel.sendPrompt(makeSendParams(prompt));

      const html = sendEmail.mock.calls[0][0].html;
      expect(html).toContain("Confirm");
      expect(html).toContain("Cancel");
      expect(html).toContain("event=YES");
      expect(html).toContain("event=NO");
    });

    it("sends text_input prompt with link", async () => {
      sendEmail.mockClear();
      const channel = emailChannel({
        sendEmail,
        callbackUrl: CALLBACK_URL,
        signingSecret: SIGNING_SECRET,
        defaultRecipient: "user@example.com",
      });
      const prompt: PromptConfig = {
        type: "text_input",
        text: "Enter reason:",
        event: "REASON",
      };

      await channel.sendPrompt(makeSendParams(prompt));

      const html = sendEmail.mock.calls[0][0].html;
      expect(html).toContain("Click here to respond");
      expect(html).toContain("event=REASON");
    });

    it("sends form prompt with link", async () => {
      sendEmail.mockClear();
      const channel = emailChannel({
        sendEmail,
        callbackUrl: CALLBACK_URL,
        signingSecret: SIGNING_SECRET,
        defaultRecipient: "user@example.com",
      });
      const prompt: PromptConfig = {
        type: "form",
        text: "Fill out details:",
        event: "SUBMIT",
        fields: [{ name: "name", label: "Name", type: "text" }],
      };

      await channel.sendPrompt(makeSendParams(prompt));

      const html = sendEmail.mock.calls[0][0].html;
      expect(html).toContain("Click here to fill out the form");
      expect(html).toContain("event=SUBMIT");
    });

    it("includes signed action links", async () => {
      sendEmail.mockClear();
      const channel = emailChannel({
        sendEmail,
        callbackUrl: CALLBACK_URL,
        signingSecret: SIGNING_SECRET,
        defaultRecipient: "user@example.com",
      });
      const prompt: PromptConfig = {
        type: "choice",
        text: "Pick one",
        options: [{ label: "Go", event: "GO" }],
      };

      await channel.sendPrompt(makeSendParams(prompt));

      const html = sendEmail.mock.calls[0][0].html;
      const expectedSig = signActionLink("wf-1", "GO", SIGNING_SECRET);
      expect(html).toContain(`sig=${expectedSig}`);
    });

    it("uses subjectPrefix when provided", async () => {
      sendEmail.mockClear();
      const channel = emailChannel({
        sendEmail,
        callbackUrl: CALLBACK_URL,
        signingSecret: SIGNING_SECRET,
        defaultRecipient: "user@example.com",
        subjectPrefix: "[Action Required]",
      });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "Approve?",
        confirmEvent: "YES",
        cancelEvent: "NO",
      };

      await channel.sendPrompt(makeSendParams(prompt));

      expect(sendEmail.mock.calls[0][0].subject).toBe("[Action Required] Approve?");
    });

    it("resolves recipient from prompt.recipient", async () => {
      sendEmail.mockClear();
      const channel = emailChannel({
        sendEmail,
        callbackUrl: CALLBACK_URL,
        signingSecret: SIGNING_SECRET,
      });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "OK?",
        confirmEvent: "YES",
        cancelEvent: "NO",
        recipient: "specific@example.com",
      };

      await channel.sendPrompt(makeSendParams(prompt));

      expect(sendEmail.mock.calls[0][0].to).toBe("specific@example.com");
    });

    it("resolves recipient from function", async () => {
      sendEmail.mockClear();
      const channel = emailChannel({
        sendEmail,
        callbackUrl: CALLBACK_URL,
        signingSecret: SIGNING_SECRET,
      });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "OK?",
        confirmEvent: "YES",
        cancelEvent: "NO",
        recipient: ({ context }) => context.email as string,
      };

      await channel.sendPrompt(
        makeSendParams(prompt, { context: { email: "dynamic@example.com" } }),
      );

      expect(sendEmail.mock.calls[0][0].to).toBe("dynamic@example.com");
    });

    it("throws when no recipient and no default", async () => {
      const channel = emailChannel({
        sendEmail,
        callbackUrl: CALLBACK_URL,
        signingSecret: SIGNING_SECRET,
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
      sendEmail.mockClear();
      const channel = emailChannel({
        sendEmail,
        callbackUrl: CALLBACK_URL,
        signingSecret: SIGNING_SECRET,
        defaultRecipient: "user@example.com",
      });
      const prompt: PromptConfig = {
        type: "confirm",
        text: ({ context }) => `Approve order ${context.orderId}?`,
        confirmEvent: "YES",
        cancelEvent: "NO",
      };

      await channel.sendPrompt(makeSendParams(prompt, { context: { orderId: "O-42" } }));

      const call = sendEmail.mock.calls[0][0];
      expect(call.subject).toBe("Approve order O-42?");
      expect(call.html).toContain("Approve order O-42?");
    });
  });

  describe("resolvePrompt", () => {
    it("sends a follow-up email", async () => {
      sendEmail.mockClear();
      const channel = emailChannel({
        sendEmail,
        callbackUrl: CALLBACK_URL,
        signingSecret: SIGNING_SECRET,
      });

      await channel.resolvePrompt!({
        handle: { to: "user@example.com", workflowId: "wf-1" },
        event: { type: "APPROVE" },
        newStateValue: "approved",
      });

      expect(sendEmail).toHaveBeenCalledOnce();
      const call = sendEmail.mock.calls[0][0];
      expect(call.to).toBe("user@example.com");
      expect(call.subject).toContain("Resolved");
      expect(call.html).toContain("APPROVE");
    });
  });
});

describe("signActionLink()", () => {
  it("produces a deterministic hex signature", () => {
    const sig1 = signActionLink("wf-1", "APPROVE", "secret");
    const sig2 = signActionLink("wf-1", "APPROVE", "secret");
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with different inputs", () => {
    const sig1 = signActionLink("wf-1", "APPROVE", "secret");
    const sig2 = signActionLink("wf-2", "APPROVE", "secret");
    expect(sig1).not.toBe(sig2);
  });
});
