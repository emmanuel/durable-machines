import { describe, it, expect } from "vitest";
import { consoleChannel } from "../../src/channels/console.js";
import type { PromptConfig } from "../../src/types.js";

const samplePrompt: PromptConfig = {
  type: "choice",
  text: "Approve?",
  options: [
    { label: "Yes", event: "APPROVE" },
    { label: "No", event: "REJECT" },
  ],
};

describe("consoleChannel()", () => {
  it("sendPrompt records the prompt and returns an index handle", async () => {
    const channel = consoleChannel();
    const { handle } = await channel.sendPrompt({
      workflowId: "wf-1",
      stateValue: "awaiting",
      prompt: samplePrompt,
      context: { orderId: "o1" },
    });

    expect(handle).toBe(0);
    expect(channel.prompts).toHaveLength(1);
    expect(channel.prompts[0].workflowId).toBe("wf-1");
    expect(channel.prompts[0].prompt).toBe(samplePrompt);
    expect(channel.prompts[0].context).toEqual({ orderId: "o1" });
  });

  it("resolvePrompt attaches resolution data to the correct record", async () => {
    const channel = consoleChannel();
    const { handle } = await channel.sendPrompt({
      workflowId: "wf-1",
      stateValue: "awaiting",
      prompt: samplePrompt,
      context: {},
    });

    await channel.resolvePrompt!({
      handle,
      event: { type: "APPROVE" },
      newStateValue: "approved",
    });

    expect(channel.prompts[0].resolvedWith).toEqual({
      event: "APPROVE",
      newStateValue: "approved",
    });
  });

  it("resolvePrompt with invalid handle is a no-op", async () => {
    const channel = consoleChannel();
    await channel.sendPrompt({
      workflowId: "wf-1",
      stateValue: "awaiting",
      prompt: samplePrompt,
      context: {},
    });

    // Out-of-range handle — should not throw or corrupt data
    await channel.resolvePrompt!({
      handle: 99,
      event: { type: "APPROVE" },
      newStateValue: "approved",
    });

    expect(channel.prompts[0].resolvedWith).toBeUndefined();
  });

  it("prompts array grows with each send", async () => {
    const channel = consoleChannel();

    await channel.sendPrompt({
      workflowId: "wf-1",
      stateValue: "a",
      prompt: samplePrompt,
      context: {},
    });
    await channel.sendPrompt({
      workflowId: "wf-2",
      stateValue: "b",
      prompt: samplePrompt,
      context: {},
    });
    await channel.sendPrompt({
      workflowId: "wf-3",
      stateValue: "c",
      prompt: samplePrompt,
      context: {},
    });

    expect(channel.prompts).toHaveLength(3);
    expect(channel.prompts.map((p) => p.workflowId)).toEqual([
      "wf-1",
      "wf-2",
      "wf-3",
    ]);
  });

  it("multiple channels are independent", async () => {
    const ch1 = consoleChannel();
    const ch2 = consoleChannel();

    await ch1.sendPrompt({
      workflowId: "wf-1",
      stateValue: "a",
      prompt: samplePrompt,
      context: {},
    });
    await ch2.sendPrompt({
      workflowId: "wf-2",
      stateValue: "b",
      prompt: samplePrompt,
      context: {},
    });

    expect(ch1.prompts).toHaveLength(1);
    expect(ch2.prompts).toHaveLength(1);
    expect(ch1.prompts[0].workflowId).toBe("wf-1");
    expect(ch2.prompts[0].workflowId).toBe("wf-2");
  });
});
