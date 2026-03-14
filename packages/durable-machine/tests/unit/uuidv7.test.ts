import { describe, it, expect } from "vitest";
import { uuidv7 } from "../../src/uuidv7.js";

describe("uuidv7", () => {
  it("returns a valid UUID string", () => {
    const id = uuidv7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("embeds version 7 and variant bits", () => {
    const id = uuidv7();
    expect(id[14]).toBe("7"); // version nibble
    expect("89ab").toContain(id[19]); // variant nibble
  });

  it("is monotonically increasing", () => {
    const ids = Array.from({ length: 100 }, () => uuidv7());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("generates unique values", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(ids.size).toBe(1000);
  });
});
