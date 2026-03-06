import { describe, it, expect } from "vitest";
import { genericSource } from "../../../src/sources/generic.js";

describe("genericSource", () => {
  const source = genericSource();

  it("verify does not throw", async () => {
    await expect(
      source.verify({ headers: {}, body: "{}" }),
    ).resolves.toBeUndefined();
  });

  it("parses JSON body", async () => {
    const payload = await source.parse({
      headers: {},
      body: JSON.stringify({ type: "test", value: 42 }),
    });
    expect(payload).toEqual({ type: "test", value: 42 });
  });

  it("throws on invalid JSON", async () => {
    await expect(
      source.parse({ headers: {}, body: "not json" }),
    ).rejects.toThrow();
  });
});
