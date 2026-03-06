import { describe, it, expect, vi, beforeEach } from "vitest";
import { slackSource } from "../../../src/sources/slack.js";
import { computeHmac } from "../../../src/hmac.js";
import { WebhookVerificationError } from "../../../src/types.js";

const SECRET = "test-slack-signing-secret";

function makeSlackRequest(body: string, overrides?: { timestamp?: string; signature?: string }) {
  const timestamp = overrides?.timestamp ?? String(Math.floor(Date.now() / 1000));
  const basestring = `v0:${timestamp}:${body}`;
  const sig = overrides?.signature ?? `v0=${computeHmac("sha256", SECRET, basestring)}`;
  return {
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": sig,
    },
    body,
  };
}

describe("slackSource", () => {
  const source = slackSource(SECRET);

  it("verifies a valid signature", async () => {
    const body = "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions" }));
    const req = makeSlackRequest(body);
    await expect(source.verify(req)).resolves.toBeUndefined();
  });

  it("rejects missing headers", async () => {
    await expect(
      source.verify({ headers: {}, body: "test" }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects old timestamps", async () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 400);
    const body = "payload={}";
    const req = makeSlackRequest(body, { timestamp: oldTimestamp });
    // Re-sign with old timestamp
    const basestring = `v0:${oldTimestamp}:${body}`;
    const sig = `v0=${computeHmac("sha256", SECRET, basestring)}`;
    await expect(
      source.verify({
        headers: {
          "x-slack-request-timestamp": oldTimestamp,
          "x-slack-signature": sig,
        },
        body,
      }),
    ).rejects.toThrow("Timestamp too old");
  });

  it("rejects invalid signature", async () => {
    const body = "payload={}";
    const req = makeSlackRequest(body, { signature: "v0=" + "a".repeat(64) });
    await expect(source.verify(req)).rejects.toThrow(WebhookVerificationError);
  });

  it("parses interactive payload from URL-encoded form", async () => {
    const innerPayload = { type: "block_actions", user: { id: "U123" } };
    const body = "payload=" + encodeURIComponent(JSON.stringify(innerPayload));
    const req = makeSlackRequest(body);
    const result = await source.parse(req);
    expect(result.type).toBe("block_actions");
    expect(result.user.id).toBe("U123");
  });

  it("throws when payload field is missing", async () => {
    const body = "other=value";
    const req = makeSlackRequest(body);
    await expect(source.parse(req)).rejects.toThrow("Missing payload field");
  });
});
