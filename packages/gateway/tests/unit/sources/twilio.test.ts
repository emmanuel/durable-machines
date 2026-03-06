import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { twilioSource } from "../../../src/sources/twilio.js";
import { WebhookVerificationError } from "../../../src/types.js";

const AUTH_TOKEN = "twilio-test-auth-token";
const WEBHOOK_URL = "https://app.example.com/webhooks/twilio";

function makeTwilioSignature(url: string, params: Record<string, string>, token: string): string {
  const sorted = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  let data = url;
  for (const [key, value] of sorted) {
    data += key + value;
  }
  return createHmac("sha1", token).update(data).digest("base64");
}

function makeTwilioRequest(params: Record<string, string>) {
  const sig = makeTwilioSignature(WEBHOOK_URL, params, AUTH_TOKEN);
  const body = new URLSearchParams(params).toString();
  return {
    headers: { "x-twilio-signature": sig },
    body,
  };
}

describe("twilioSource", () => {
  const source = twilioSource(AUTH_TOKEN, WEBHOOK_URL);

  it("verifies valid signature", async () => {
    const params = {
      From: "+15551234567",
      To: "+15559876543",
      Body: "YES",
      MessageSid: "SM_abc123",
      AccountSid: "AC_test",
    };
    const req = makeTwilioRequest(params);
    await expect(source.verify(req)).resolves.toBeUndefined();
  });

  it("rejects missing header", async () => {
    await expect(
      source.verify({ headers: {}, body: "From=%2B15551234567" }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects bad signature", async () => {
    await expect(
      source.verify({
        headers: { "x-twilio-signature": "badsignature==" },
        body: "From=%2B15551234567&Body=YES",
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects tampered body", async () => {
    const params = {
      From: "+15551234567",
      Body: "YES",
    };
    const req = makeTwilioRequest(params);
    // Tamper with the body after signing
    req.body = new URLSearchParams({ From: "+15551234567", Body: "NO" }).toString();
    await expect(source.verify(req)).rejects.toThrow(WebhookVerificationError);
  });

  it("parses inbound SMS fields", async () => {
    const params = {
      From: "+15551234567",
      To: "+15559876543",
      Body: "Hello world",
      MessageSid: "SM_msg_456",
      AccountSid: "AC_acct_789",
    };
    const req = makeTwilioRequest(params);
    const result = await source.parse(req);
    expect(result.From).toBe("+15551234567");
    expect(result.To).toBe("+15559876543");
    expect(result.Body).toBe("Hello world");
    expect(result.MessageSid).toBe("SM_msg_456");
    expect(result.AccountSid).toBe("AC_acct_789");
  });

  it("handles empty body fields gracefully", async () => {
    const params = { From: "+15551234567" };
    const req = makeTwilioRequest(params);
    const result = await source.parse(req);
    expect(result.From).toBe("+15551234567");
    expect(result.To).toBe("");
    expect(result.Body).toBe("");
    expect(result.MessageSid).toBe("");
  });
});
