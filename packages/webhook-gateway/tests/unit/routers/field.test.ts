import { describe, it, expect } from "vitest";
import { fieldRouter } from "../../../src/routers/field.js";

describe("fieldRouter", () => {
  it("extracts a single workflow ID", () => {
    const router = fieldRouter((p: { wfId: string }) => p.wfId);
    expect(router.route({ wfId: "wf-123" })).toBe("wf-123");
  });

  it("returns array for multi-target", () => {
    const router = fieldRouter((p: { ids: string[] }) => p.ids);
    expect(router.route({ ids: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("returns null when no match", () => {
    const router = fieldRouter(() => null);
    expect(router.route({})).toBeNull();
  });
});
