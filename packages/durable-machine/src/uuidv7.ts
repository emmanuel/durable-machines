import { randomBytes } from "node:crypto";

// Sub-millisecond counter for monotonicity (RFC 9562 §6.2)
let lastMs = 0;
let seq = 0;

/**
 * Generate a UUIDv7 string (RFC 9562). Time-ordered for better
 * B-tree index locality in PostgreSQL UUID columns.
 *
 * Uses a 12-bit sub-millisecond counter to guarantee monotonic
 * ordering within the same millisecond.
 */
export function uuidv7(): string {
  const now = Date.now();

  if (now === lastMs) {
    seq++;
  } else {
    lastMs = now;
    seq = 0;
  }

  // 6 bytes: 48-bit millisecond timestamp (big-endian)
  const buf = Buffer.alloc(16);
  buf[0] = (now / 2 ** 40) & 0xff;
  buf[1] = (now / 2 ** 32) & 0xff;
  buf[2] = (now / 2 ** 24) & 0xff;
  buf[3] = (now / 2 ** 16) & 0xff;
  buf[4] = (now / 2 ** 8) & 0xff;
  buf[5] = now & 0xff;

  // Bytes 6-7: version (0111) + 12-bit counter
  buf[6] = 0x70 | ((seq >> 8) & 0x0f); // version 7 + counter high 4 bits
  buf[7] = seq & 0xff; // counter low 8 bits

  // Bytes 8-15: variant (10xx) + random
  const rand = randomBytes(8);
  rand[0] = (rand[0] & 0x3f) | 0x80; // variant 10
  rand.copy(buf, 8);

  const hex = buf.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
