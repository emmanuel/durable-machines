import { describe, it, expect } from "vitest";
import { slashCommandBinding } from "../../../src/sources/slack-slash.js";
import { computeHmac } from "../../../src/hmac.js";
import { createMockClient } from "../../helpers/mock-client.js";
import { createWebhookGateway } from "../../../src/gateway.js";

const SECRET = "test-slash-secret";

function signBody(body: string, timestamp?: string) {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const basestring = `v0:${ts}:${body}`;
  const sig = `v0=${computeHmac("sha256", SECRET, basestring)}`;
  return { timestamp: ts, signature: sig };
}

describe("slashCommandBinding", () => {
  const client = createMockClient();

  const binding = slashCommandBinding("/slack/command", {
    signingSecret: SECRET,
    eventMap: { approve: "APPROVE", reject: "REJECT" },
    ackText: "Got it!",
  }, client);

  it("routes to workflow ID from parsed text", () => {
    const result = binding.router.route({
      subcommand: "approve",
      workflowId: "wf-123",
      args: {},
      raw: {} as any,
    });
    expect(result).toBe("wf-123");
  });

  it("returns null for status subcommand", () => {
    const result = binding.router.route({
      subcommand: "status",
      workflowId: "wf-123",
      args: {},
      raw: {} as any,
    });
    expect(result).toBeNull();
  });

  it("transforms using eventMap", () => {
    const event = binding.transform.transform({
      subcommand: "approve",
      workflowId: "wf-123",
      args: { reason: "looks good" },
      raw: {} as any,
    });
    expect(event).toEqual({ type: "APPROVE", reason: "looks good" });
  });

  it("uses subcommand as type when not in eventMap", () => {
    const event = binding.transform.transform({
      subcommand: "custom",
      workflowId: "wf-123",
      args: {},
      raw: {} as any,
    });
    expect(event.type).toBe("custom");
  });

  describe("full pipeline via gateway", () => {
    const app = createWebhookGateway({ client, bindings: [binding] });

    it("acks slash command and dispatches event", async () => {
      client.reset();
      const body = "command=/workflow&text=approve wf-123 --reason test&user_id=U1&user_name=bob&trigger_id=t1&channel_id=C1&channel_name=general&team_id=T1&team_domain=test&response_url=https://hooks.slack.com/test";
      const { timestamp, signature } = signBody(body);

      const res = await app.request("/slack/command", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
        body,
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.text).toBe("Got it!");

      // Give fire-and-forget a tick to complete
      await new Promise((r) => setTimeout(r, 10));
      expect(client.sends).toHaveLength(1);
      expect(client.sends[0].workflowId).toBe("wf-123");
      expect(client.sends[0].message).toEqual({ type: "APPROVE", reason: "test" });
    });

    it("handles status subcommand inline", async () => {
      client.reset();
      client.eventStubs.set("wf-456:xstate.state", { value: "active" });

      const body = "command=/workflow&text=status wf-456&user_id=U1&user_name=bob&trigger_id=t1&channel_id=C1&channel_name=general&team_id=T1&team_domain=test&response_url=https://hooks.slack.com/test";
      const { timestamp, signature } = signBody(body);

      const res = await app.request("/slack/command", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
        body,
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.text).toContain("wf-456");
      expect(json.text).toContain("active");
      // No events dispatched for status
      expect(client.sends).toHaveLength(0);
    });
  });
});
