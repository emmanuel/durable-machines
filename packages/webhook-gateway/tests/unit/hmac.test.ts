import { describe, it, expect } from "vitest";
import { computeHmac, verifyHmac } from "../../src/hmac.js";
import { WebhookVerificationError } from "../../src/types.js";

describe("computeHmac", () => {
  it("returns consistent hex digest", () => {
    const result = computeHmac("sha256", "secret", "payload");
    expect(result).toMatch(/^[0-9a-f]{64}$/);
    // Same inputs → same output
    expect(computeHmac("sha256", "secret", "payload")).toBe(result);
  });

  it("different secrets produce different digests", () => {
    const a = computeHmac("sha256", "secret-a", "payload");
    const b = computeHmac("sha256", "secret-b", "payload");
    expect(a).not.toBe(b);
  });
});

describe("verifyHmac", () => {
  it("passes for matching signature", () => {
    const sig = computeHmac("sha256", "secret", "payload");
    expect(() => verifyHmac("sha256", "secret", "payload", sig)).not.toThrow();
  });

  it("throws WebhookVerificationError for mismatched signature", () => {
    const badSig = "a".repeat(64);
    expect(() => verifyHmac("sha256", "secret", "payload", badSig, "test")).toThrow(
      WebhookVerificationError,
    );
  });

  it("throws for wrong-length signature", () => {
    expect(() => verifyHmac("sha256", "secret", "payload", "abcd", "test")).toThrow(
      WebhookVerificationError,
    );
  });

  it("includes source in error", () => {
    try {
      verifyHmac("sha256", "secret", "payload", "a".repeat(64), "github");
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookVerificationError);
      expect((err as WebhookVerificationError).source).toBe("github");
    }
  });
});
