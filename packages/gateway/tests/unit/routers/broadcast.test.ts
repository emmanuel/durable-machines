import { describe, it, expect } from "vitest";
import { broadcastRouter } from "../../../src/routers/broadcast.js";

describe("broadcastRouter", () => {
  it("returns matching workflow IDs", async () => {
    const router = broadcastRouter(
      (p: { org: string }) => p.org,
      async (filter) => [`wf-${filter}-1`, `wf-${filter}-2`],
    );
    const result = await router.route({ org: "acme" });
    expect(result).toEqual(["wf-acme-1", "wf-acme-2"]);
  });

  it("returns null when no workflows match", async () => {
    const router = broadcastRouter(
      () => "none",
      async () => [],
    );
    const result = await router.route({});
    expect(result).toBeNull();
  });
});
