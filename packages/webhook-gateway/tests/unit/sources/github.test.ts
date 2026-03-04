import { describe, it, expect } from "vitest";
import { githubSource } from "../../../src/sources/github.js";
import { computeHmac } from "../../../src/hmac.js";
import { WebhookVerificationError } from "../../../src/types.js";

const SECRET = "github-webhook-secret";

function makeGithubRequest(body: string, event = "push", deliveryId = "d-123") {
  const sig = computeHmac("sha256", SECRET, body);
  return {
    headers: {
      "x-hub-signature-256": `sha256=${sig}`,
      "x-github-event": event,
      "x-github-delivery": deliveryId,
    },
    body,
  };
}

describe("githubSource", () => {
  const source = githubSource(SECRET);

  it("verifies valid signature", async () => {
    const body = JSON.stringify({ action: "opened", number: 1 });
    const req = makeGithubRequest(body);
    await expect(source.verify(req)).resolves.toBeUndefined();
  });

  it("rejects missing header", async () => {
    await expect(
      source.verify({ headers: {}, body: "{}" }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects bad signature", async () => {
    await expect(
      source.verify({
        headers: { "x-hub-signature-256": "sha256=" + "a".repeat(64) },
        body: "{}",
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("parses body with event and delivery headers", async () => {
    const body = JSON.stringify({ action: "opened", pull_request: { number: 42 } });
    const req = makeGithubRequest(body, "pull_request", "del-789");
    const result = await source.parse(req);
    expect(result.event).toBe("pull_request");
    expect(result.deliveryId).toBe("del-789");
    expect(result.payload.action).toBe("opened");
  });

  it("uses defaults for missing headers", async () => {
    const body = JSON.stringify({ test: true });
    const result = await source.parse({ headers: {}, body });
    expect(result.event).toBe("unknown");
    expect(result.deliveryId).toBe("");
  });
});
