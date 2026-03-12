import { describe, it, expect } from "vitest";
import { stripeSource } from "../../../src/sources/stripe.js";
import { computeHmac } from "../../../src/hmac.js";
import { WebhookVerificationError } from "../../../src/types.js";

const SECRET = "whsec_test_secret";

function makeStripeRequest(body: string, overrides?: { timestamp?: string; signature?: string }) {
  const timestamp = overrides?.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signedPayload = `${timestamp}.${body}`;
  const v1 = overrides?.signature ?? computeHmac("sha256", SECRET, signedPayload);
  return {
    headers: {
      "stripe-signature": `t=${timestamp},v1=${v1}`,
    },
    body,
  };
}

describe("stripeSource", () => {
  const source = stripeSource(SECRET);

  it("verifies valid signature", async () => {
    const body = JSON.stringify({ id: "evt_123", type: "payment_intent.succeeded" });
    const req = makeStripeRequest(body);
    await expect(source.verify(req)).resolves.toBeUndefined();
  });

  it("rejects missing header", async () => {
    await expect(
      source.verify({ headers: {}, body: "{}" }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects invalid format", async () => {
    await expect(
      source.verify({ headers: { "stripe-signature": "garbage" }, body: "{}" }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects non-numeric timestamp", async () => {
    await expect(
      source.verify({
        headers: { "stripe-signature": `t=notanumber,v1=${"a".repeat(64)}` },
        body: "{}",
      }),
    ).rejects.toThrow("Invalid timestamp");
  });

  it("rejects old timestamp", async () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 400);
    const body = "{}";
    const signedPayload = `${oldTs}.${body}`;
    const v1 = computeHmac("sha256", SECRET, signedPayload);
    await expect(
      source.verify({
        headers: { "stripe-signature": `t=${oldTs},v1=${v1}` },
        body,
      }),
    ).rejects.toThrow("Timestamp too old");
  });

  it("rejects bad signature", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    await expect(
      source.verify({
        headers: { "stripe-signature": `t=${ts},v1=${"a".repeat(64)}` },
        body: "{}",
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("parses JSON body", async () => {
    const body = JSON.stringify({
      id: "evt_123",
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_123" } },
    });
    const req = makeStripeRequest(body);
    const event = await source.parse(req);
    expect(event.id).toBe("evt_123");
    expect(event.type).toBe("payment_intent.succeeded");
  });
});
