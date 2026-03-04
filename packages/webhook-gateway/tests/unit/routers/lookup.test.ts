import { describe, it, expect } from "vitest";
import { lookupRouter } from "../../../src/routers/lookup.js";

describe("lookupRouter", () => {
  it("extracts key and looks up workflow ID", async () => {
    const router = lookupRouter(
      (p: { externalId: string }) => p.externalId,
      async (key) => `wf-${key}`,
    );
    const result = await router.route({ externalId: "ext-1" });
    expect(result).toBe("wf-ext-1");
  });

  it("returns null when query returns null", async () => {
    const router = lookupRouter(
      (p: { id: string }) => p.id,
      async () => null,
    );
    const result = await router.route({ id: "missing" });
    expect(result).toBeNull();
  });

  it("returns array from query", async () => {
    const router = lookupRouter(
      (p: { tag: string }) => p.tag,
      async (tag) => [`wf-${tag}-1`, `wf-${tag}-2`],
    );
    const result = await router.route({ tag: "urgent" });
    expect(result).toEqual(["wf-urgent-1", "wf-urgent-2"]);
  });
});
