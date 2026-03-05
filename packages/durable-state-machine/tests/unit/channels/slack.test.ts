import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { slackChannel } from "../../../src/channels/slack.js";
import type { PromptConfig, SendPromptParams } from "../../../src/types.js";

const BOT_TOKEN = "xoxb-test-token";
const DEFAULT_CHANNEL = "C01234ABCDE";

function makeSendParams(prompt: PromptConfig, overrides?: Partial<SendPromptParams>): SendPromptParams {
  return {
    workflowId: "wf-1",
    stateValue: "awaiting",
    prompt,
    context: {},
    ...overrides,
  };
}

describe("slackChannel()", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, ts: "1234.5678", channel: DEFAULT_CHANNEL }),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("sendPrompt", () => {
    it("sends choice prompt with buttons", async () => {
      const channel = slackChannel({ botToken: BOT_TOKEN, defaultChannel: DEFAULT_CHANNEL });
      const prompt: PromptConfig = {
        type: "choice",
        text: "Approve the deployment?",
        options: [
          { label: "Approve", event: "APPROVE", style: "primary" },
          { label: "Reject", event: "REJECT", style: "danger" },
        ],
      };

      const { handle } = await channel.sendPrompt(makeSendParams(prompt));

      expect(handle).toEqual({ channel: DEFAULT_CHANNEL, ts: "1234.5678" });
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://slack.com/api/chat.postMessage");
      expect(opts.headers.Authorization).toBe(`Bearer ${BOT_TOKEN}`);

      const body = JSON.parse(opts.body);
      expect(body.channel).toBe(DEFAULT_CHANNEL);
      expect(body.blocks).toHaveLength(2);
      expect(body.blocks[0].type).toBe("section");
      expect(body.blocks[1].type).toBe("actions");
      expect(body.blocks[1].elements).toHaveLength(2);
      expect(body.blocks[1].elements[0].action_id).toBe("APPROVE");
      expect(body.blocks[1].elements[0].value).toBe("wf-1");
      expect(body.blocks[1].elements[0].style).toBe("primary");
      expect(body.blocks[1].elements[1].style).toBe("danger");
    });

    it("sends confirm prompt with two buttons", async () => {
      const channel = slackChannel({ botToken: BOT_TOKEN, defaultChannel: DEFAULT_CHANNEL });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "Are you sure?",
        confirmEvent: "YES",
        cancelEvent: "NO",
      };

      await channel.sendPrompt(makeSendParams(prompt));

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.blocks[1].elements).toHaveLength(2);
      expect(body.blocks[1].elements[0].action_id).toBe("YES");
      expect(body.blocks[1].elements[0].style).toBe("primary");
      expect(body.blocks[1].elements[1].action_id).toBe("NO");
      expect(body.blocks[1].elements[1].style).toBe("danger");
    });

    it("sends text_input prompt with input block", async () => {
      const channel = slackChannel({ botToken: BOT_TOKEN, defaultChannel: DEFAULT_CHANNEL });
      const prompt: PromptConfig = {
        type: "text_input",
        text: "Enter your reason:",
        event: "REASON",
        placeholder: "Type here...",
      };

      await channel.sendPrompt(makeSendParams(prompt));

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.blocks[1].type).toBe("input");
      expect(body.blocks[1].element.type).toBe("plain_text_input");
      expect(body.blocks[1].element.action_id).toBe("REASON");
      expect(body.blocks[1].element.placeholder.text).toBe("Type here...");
    });

    it("sends form prompt with multiple input blocks", async () => {
      const channel = slackChannel({ botToken: BOT_TOKEN, defaultChannel: DEFAULT_CHANNEL });
      const prompt: PromptConfig = {
        type: "form",
        text: "Fill out details:",
        event: "SUBMIT",
        fields: [
          { name: "name", label: "Name", type: "text", required: true },
          { name: "dept", label: "Department", type: "select", options: ["Eng", "Sales"] },
        ],
      };

      await channel.sendPrompt(makeSendParams(prompt));

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      // section + 2 input blocks
      expect(body.blocks).toHaveLength(3);
      expect(body.blocks[1].type).toBe("input");
      expect(body.blocks[1].element.type).toBe("plain_text_input");
      expect(body.blocks[2].element.type).toBe("static_select");
    });

    it("resolves recipient from prompt.recipient string", async () => {
      const channel = slackChannel({ botToken: BOT_TOKEN });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "OK?",
        confirmEvent: "YES",
        cancelEvent: "NO",
        recipient: "U999",
      };

      await channel.sendPrompt(makeSendParams(prompt));

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.channel).toBe("U999");
    });

    it("resolves recipient from prompt.recipient function", async () => {
      const channel = slackChannel({ botToken: BOT_TOKEN });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "OK?",
        confirmEvent: "YES",
        cancelEvent: "NO",
        recipient: ({ context }) => context.slackUser as string,
      };

      await channel.sendPrompt(makeSendParams(prompt, { context: { slackUser: "U123" } }));

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.channel).toBe("U123");
    });

    it("throws when no recipient and no defaultChannel", async () => {
      const channel = slackChannel({ botToken: BOT_TOKEN });
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
      const channel = slackChannel({ botToken: BOT_TOKEN, defaultChannel: DEFAULT_CHANNEL });
      const prompt: PromptConfig = {
        type: "confirm",
        text: ({ context }) => `Approve order ${context.orderId}?`,
        confirmEvent: "YES",
        cancelEvent: "NO",
      };

      await channel.sendPrompt(makeSendParams(prompt, { context: { orderId: "O-42" } }));

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.text).toBe("Approve order O-42?");
    });

    it("throws on Slack API error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: false, error: "channel_not_found" }),
      });

      const channel = slackChannel({ botToken: BOT_TOKEN, defaultChannel: DEFAULT_CHANNEL });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "OK?",
        confirmEvent: "YES",
        cancelEvent: "NO",
      };

      await expect(channel.sendPrompt(makeSendParams(prompt))).rejects.toThrow(
        "channel_not_found",
      );
    });
  });

  describe("resolvePrompt", () => {
    it("calls chat.update with resolved text", async () => {
      const channel = slackChannel({ botToken: BOT_TOKEN, defaultChannel: DEFAULT_CHANNEL });

      await channel.resolvePrompt!({
        handle: { channel: "C123", ts: "1234.5678" },
        event: { type: "APPROVE" },
        newStateValue: "approved",
      });

      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://slack.com/api/chat.update");
      const body = JSON.parse(opts.body);
      expect(body.channel).toBe("C123");
      expect(body.ts).toBe("1234.5678");
      expect(body.text).toContain("APPROVE");
    });
  });

  describe("updatePrompt", () => {
    it("calls chat.update with re-rendered blocks", async () => {
      const channel = slackChannel({ botToken: BOT_TOKEN, defaultChannel: DEFAULT_CHANNEL });
      const prompt: PromptConfig = {
        type: "confirm",
        text: "Updated prompt text",
        confirmEvent: "YES",
        cancelEvent: "NO",
      };

      await channel.updatePrompt!({
        handle: { channel: "C123", ts: "1234.5678" },
        prompt,
        context: {},
      });

      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://slack.com/api/chat.update");
      const body = JSON.parse(opts.body);
      expect(body.text).toBe("Updated prompt text");
      expect(body.blocks).toHaveLength(2);
    });
  });
});
