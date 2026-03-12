import { describe, it, expect } from "vitest";
import { actionLinkSource } from "../../../src/sources/action-link.js";
import { computeHmac } from "../../../src/hmac.js";
import { WebhookVerificationError } from "../../../src/types.js";

const SECRET = "action-link-test-secret";

function makeActionLinkRequest(workflowId: string, event: string, createdAt = Date.now()) {
  const sig = computeHmac("sha256", SECRET, `${workflowId}:${event}:${createdAt}`);
  const body = new URLSearchParams({ workflowId, event, sig, t: String(createdAt) }).toString();
  return { headers: {}, body };
}

describe("actionLinkSource", () => {
  const source = actionLinkSource(SECRET);

  it("verifies valid signature with timestamp", async () => {
    const req = makeActionLinkRequest("wf-1", "APPROVE");
    await expect(source.verify(req)).resolves.toBeUndefined();
  });

  it("rejects missing parameters", async () => {
    await expect(
      source.verify({ headers: {}, body: "" }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects missing workflowId", async () => {
    const body = new URLSearchParams({ event: "APPROVE", sig: "deadbeef", t: String(Date.now()) }).toString();
    await expect(
      source.verify({ headers: {}, body }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects tampered signature", async () => {
    const sig = "a".repeat(64);
    const t = String(Date.now());
    const body = new URLSearchParams({ workflowId: "wf-1", event: "APPROVE", sig, t }).toString();
    await expect(
      source.verify({ headers: {}, body }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects tampered workflowId", async () => {
    const createdAt = Date.now();
    const sig = computeHmac("sha256", SECRET, `wf-1:APPROVE:${createdAt}`);
    const body = new URLSearchParams({ workflowId: "wf-HACKED", event: "APPROVE", sig, t: String(createdAt) }).toString();
    await expect(
      source.verify({ headers: {}, body }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects tampered event", async () => {
    const createdAt = Date.now();
    const sig = computeHmac("sha256", SECRET, `wf-1:APPROVE:${createdAt}`);
    const body = new URLSearchParams({ workflowId: "wf-1", event: "REJECT", sig, t: String(createdAt) }).toString();
    await expect(
      source.verify({ headers: {}, body }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects expired links", async () => {
    const expiredAt = Date.now() - 90_000_000; // 25 hours ago
    const req = makeActionLinkRequest("wf-1", "APPROVE", expiredAt);
    await expect(source.verify(req)).rejects.toThrow("expired");
  });

  it("rejects links without timestamp", async () => {
    const sig = computeHmac("sha256", SECRET, "wf-1APPROVE");
    const body = new URLSearchParams({ workflowId: "wf-1", event: "APPROVE", sig }).toString();
    await expect(
      source.verify({ headers: {}, body }),
    ).rejects.toThrow("Missing timestamp");
  });

  it("respects custom maxAgeSec", async () => {
    const shortLived = actionLinkSource(SECRET, { maxAgeSec: 1 });
    const twoSecondsAgo = Date.now() - 2000;
    const req = makeActionLinkRequest("wf-1", "APPROVE", twoSecondsAgo);
    await expect(shortLived.verify(req)).rejects.toThrow("expired");
  });

  it("parses workflowId and event", async () => {
    const req = makeActionLinkRequest("wf-42", "DEPLOY");
    const result = await source.parse(req);
    expect(result.workflowId).toBe("wf-42");
    expect(result.event).toBe("DEPLOY");
  });
});
