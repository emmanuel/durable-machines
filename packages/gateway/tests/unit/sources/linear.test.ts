import { describe, it, expect } from "vitest";
import { linearSource } from "../../../src/sources/linear.js";
import { computeHmac } from "../../../src/hmac.js";
import { WebhookVerificationError } from "../../../src/types.js";

const SECRET = "linear-webhook-secret";

function makeLinearRequest(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  const sig = computeHmac("sha256", SECRET, body);
  return {
    headers: { "linear-signature": sig },
    body,
  };
}

describe("linearSource", () => {
  const source = linearSource(SECRET);

  it("verifies valid signature", async () => {
    const req = makeLinearRequest({
      action: "create",
      type: "Issue",
      data: { id: "iss-1" },
      webhookTimestamp: Date.now(),
    });
    await expect(source.verify(req)).resolves.toBeUndefined();
  });

  it("rejects missing header", async () => {
    await expect(
      source.verify({ headers: {}, body: "{}" }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects bad signature", async () => {
    await expect(
      source.verify({
        headers: { "linear-signature": "a".repeat(64) },
        body: JSON.stringify({ webhookTimestamp: Date.now() }),
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects non-numeric webhookTimestamp", async () => {
    const payload = { action: "create", type: "Issue", data: {}, webhookTimestamp: "notanumber" };
    const body = JSON.stringify(payload);
    const sig = computeHmac("sha256", SECRET, body);
    await expect(
      source.verify({ headers: { "linear-signature": sig }, body }),
    ).rejects.toThrow("Missing or invalid webhookTimestamp");
  });

  it("rejects null webhookTimestamp", async () => {
    const payload = { action: "create", type: "Issue", data: {}, webhookTimestamp: null };
    const body = JSON.stringify(payload);
    const sig = computeHmac("sha256", SECRET, body);
    await expect(
      source.verify({ headers: { "linear-signature": sig }, body }),
    ).rejects.toThrow("Missing or invalid webhookTimestamp");
  });

  it("rejects old timestamp", async () => {
    const oldPayload = {
      action: "create",
      type: "Issue",
      data: {},
      webhookTimestamp: Date.now() - 120_000, // 2 minutes old
    };
    const body = JSON.stringify(oldPayload);
    const sig = computeHmac("sha256", SECRET, body);
    await expect(
      source.verify({ headers: { "linear-signature": sig }, body }),
    ).rejects.toThrow("Timestamp too old");
  });

  it("parses payload", async () => {
    const payload = {
      action: "update",
      type: "Issue",
      data: { id: "iss-1", title: "Bug" },
      updatedFrom: { title: "Old" },
      webhookTimestamp: Date.now(),
      createdAt: "2024-01-01T00:00:00Z",
    };
    const req = makeLinearRequest(payload);
    const result = await source.parse(req);
    expect(result.action).toBe("update");
    expect(result.type).toBe("Issue");
    expect(result.data.id).toBe("iss-1");
    expect(result.updatedFrom?.title).toBe("Old");
  });
});
