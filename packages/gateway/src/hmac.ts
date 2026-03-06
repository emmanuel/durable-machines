import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "./types.js";

/**
 * Compute HMAC hex digest for a payload.
 *
 * @param algorithm - Hash algorithm (e.g. `"sha256"`).
 * @param secret - HMAC secret key.
 * @param payload - Data to sign.
 * @returns Hex-encoded HMAC digest.
 */
export function computeHmac(
  algorithm: string,
  secret: string,
  payload: string,
): string {
  return createHmac(algorithm, secret).update(payload).digest("hex");
}

/**
 * Verify an HMAC signature using timing-safe comparison.
 *
 * @param algorithm - Hash algorithm (e.g. `"sha256"`).
 * @param secret - HMAC secret key.
 * @param payload - Data that was signed.
 * @param expectedHex - Expected hex digest to compare against.
 * @param source - Provider name for error diagnostics.
 * @throws {WebhookVerificationError} On signature mismatch.
 */
export function verifyHmac(
  algorithm: string,
  secret: string,
  payload: string,
  expectedHex: string,
  source?: string,
): void {
  const computed = computeHmac(algorithm, secret, payload);
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(computed, "hex");

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new WebhookVerificationError(
      "Signature mismatch",
      source,
    );
  }
}
