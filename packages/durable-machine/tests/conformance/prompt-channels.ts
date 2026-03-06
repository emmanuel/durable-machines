import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  approvalMachine,
  multiStepMachine,
  dynamicPromptMachine,
  promptWithTimeoutMachine,
} from "../fixtures/machines.js";
import { waitForState, consoleChannel } from "../fixtures/helpers.js";
import type { BackendFixture } from "../fixtures/helpers.js";

export function promptConformance(backend: BackendFixture) {
  describe(`prompt & channel adapters [${backend.name}]`, () => {
    const approvalChannel = consoleChannel();
    const durableApproval = backend.createMachine(approvalMachine, {
      channels: [approvalChannel],
    });

    const multiStepChannel = consoleChannel();
    const durableMultiStep = backend.createMachine(multiStepMachine, {
      channels: [multiStepChannel],
    });

    const dynamicChannel = consoleChannel();
    const durableDynamic = backend.createMachine(dynamicPromptMachine, {
      channels: [dynamicChannel],
    });

    const timeoutChannel = consoleChannel();
    const durableTimeout = backend.createMachine(promptWithTimeoutMachine, {
      channels: [timeoutChannel],
    });

    const durableNoChannel = backend.createMachine(approvalMachine);

    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());

    it("sends a prompt to the channel when entering a durable state", async () => {
      const id = `prompt-send-${Date.now()}`;
      const handle = await durableApproval.start(id, {});

      await waitForState(handle, "pending");
      await new Promise((r) => setTimeout(r, 500));

      expect(approvalChannel.prompts.length).toBeGreaterThanOrEqual(1);
      const sent = approvalChannel.prompts.find((p) => p.workflowId === id);
      expect(sent).toBeDefined();
      expect(sent!.prompt.type).toBe("choice");
      expect(sent!.prompt.text).toBe("Do you approve this request?");

      await handle.send({ type: "APPROVE" });
      await handle.getResult();
    });

    it("resolves the prompt after a transition", async () => {
      const id = `prompt-resolve-${Date.now()}`;
      const handle = await durableApproval.start(id, {});

      await waitForState(handle, "pending");
      await new Promise((r) => setTimeout(r, 500));

      await handle.send({ type: "REJECT" });
      const result = await handle.getResult();

      expect(result).toMatchObject({ decision: "rejected" });

      const sent = approvalChannel.prompts.find((p) => p.workflowId === id);
      expect(sent).toBeDefined();
      expect(sent!.resolvedWith).toBeDefined();
      expect(sent!.resolvedWith!.newStateValue).toBe("rejected");
    });

    it("works without channels (no prompt sent)", async () => {
      const id = `no-channel-${Date.now()}`;
      const handle = await durableNoChannel.start(id, {});

      await waitForState(handle, "pending");
      await handle.send({ type: "APPROVE" });

      const result = await handle.getResult();
      expect(result).toMatchObject({ decision: "approved" });
    });

    it("sends prompts for each state in a multi-step flow", async () => {
      const id = `multi-step-${Date.now()}`;
      const handle = await durableMultiStep.start(id, {});

      await waitForState(handle, "step1");
      await new Promise((r) => setTimeout(r, 500));

      await handle.send({ type: "NEXT" });
      await waitForState(handle, "step2");
      await new Promise((r) => setTimeout(r, 500));

      await handle.send({ type: "NEXT" });
      const result = await handle.getResult();

      expect(result).toMatchObject({ step: 3 });

      const myPrompts = multiStepChannel.prompts.filter((p) => p.workflowId === id);
      expect(myPrompts.length).toBeGreaterThanOrEqual(2);
    });

    it("passes snapshot context to the channel", async () => {
      const id = `dynamic-ctx-${Date.now()}`;
      const handle = await durableDynamic.start(id, { name: "Alice" });

      await waitForState(handle, "confirming");
      await new Promise((r) => setTimeout(r, 500));

      const sent = dynamicChannel.prompts.find((p) => p.workflowId === id);
      expect(sent).toBeDefined();
      expect(sent!.context).toMatchObject({ name: "Alice" });

      await handle.send({ type: "CONFIRM" });
      const result = await handle.getResult();
      expect(result).toMatchObject({ confirmed: true });
    });

    it("resolves prompt when after timeout fires", async () => {
      const id = `prompt-timeout-${Date.now()}`;
      const handle = await durableTimeout.start(id, {});

      const result = await handle.getResult();

      expect(result).toMatchObject({ timedOut: true });

      const sent = timeoutChannel.prompts.find((p) => p.workflowId === id);
      expect(sent).toBeDefined();
      expect(sent!.resolvedWith).toBeDefined();
      expect(sent!.resolvedWith!.newStateValue).toBe("timedOut");
    });
  });
}
