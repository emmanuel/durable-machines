import { describe, it, expect } from "vitest";
import { directTransform } from "../../../src/transforms/direct.js";

describe("directTransform", () => {
  it("extracts event from payload", () => {
    const transform = directTransform((p: { eventType: string; data: string }) => ({
      type: p.eventType,
      data: p.data,
    }));
    const event = transform.transform({ eventType: "APPROVE", data: "yes" });
    expect(event).toEqual({ type: "APPROVE", data: "yes" });
  });

  it("supports complex extraction", () => {
    const transform = directTransform((p: { action: string; issue: { id: number } }) => ({
      type: `issue.${p.action}`,
      issueId: p.issue.id,
    }));
    const event = transform.transform({ action: "opened", issue: { id: 42 } });
    expect(event).toEqual({ type: "issue.opened", issueId: 42 });
  });
});
