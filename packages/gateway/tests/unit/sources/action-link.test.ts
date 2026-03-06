import { describe, it, expect } from "vitest";
import { actionLinkSource } from "../../../src/sources/action-link.js";
import { computeHmac } from "../../../src/hmac.js";
import { WebhookVerificationError } from "../../../src/types.js";

const SECRET = "action-link-test-secret";

function makeActionLinkRequest(workflowId: string, event: string) {
  const sig = computeHmac("sha256", SECRET, workflowId + event);
  const body = new URLSearchParams({ workflowId, event, sig }).toString();
  return { headers: {}, body };
}

describe("actionLinkSource", () => {
  const source = actionLinkSource(SECRET);

  it("verifies valid signature", async () => {
    const req = makeActionLinkRequest("wf-1", "APPROVE");
    await expect(source.verify(req)).resolves.toBeUndefined();
  });

  it("rejects missing parameters", async () => {
    await expect(
      source.verify({ headers: {}, body: "" }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects missing workflowId", async () => {
    const body = new URLSearchParams({ event: "APPROVE", sig: "deadbeef" }).toString();
    await expect(
      source.verify({ headers: {}, body }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects tampered signature", async () => {
    const sig = "a".repeat(64);
    const body = new URLSearchParams({ workflowId: "wf-1", event: "APPROVE", sig }).toString();
    await expect(
      source.verify({ headers: {}, body }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects tampered workflowId", async () => {
    const sig = computeHmac("sha256", SECRET, "wf-1" + "APPROVE");
    const body = new URLSearchParams({ workflowId: "wf-HACKED", event: "APPROVE", sig }).toString();
    await expect(
      source.verify({ headers: {}, body }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects tampered event", async () => {
    const sig = computeHmac("sha256", SECRET, "wf-1" + "APPROVE");
    const body = new URLSearchParams({ workflowId: "wf-1", event: "REJECT", sig }).toString();
    await expect(
      source.verify({ headers: {}, body }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("parses workflowId and event", async () => {
    const req = makeActionLinkRequest("wf-42", "DEPLOY");
    const result = await source.parse(req);
    expect(result.workflowId).toBe("wf-42");
    expect(result.event).toBe("DEPLOY");
  });
});
