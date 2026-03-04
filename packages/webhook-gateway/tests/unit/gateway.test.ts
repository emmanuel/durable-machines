import { describe, it, expect, beforeEach } from "vitest";
import { createWebhookGateway } from "../../src/gateway.js";
import { genericSource } from "../../src/sources/generic.js";
import { fieldRouter } from "../../src/routers/field.js";
import { directTransform } from "../../src/transforms/direct.js";
import { createMockClient } from "../helpers/mock-client.js";
import { WebhookVerificationError } from "../../src/types.js";
import type { WebhookSource, RawRequest } from "../../src/types.js";

describe("createWebhookGateway", () => {
  const client = createMockClient();

  beforeEach(() => {
    client.reset();
  });

  const app = createWebhookGateway({
    client,
    bindings: [
      {
        path: "/webhooks/test",
        source: genericSource(),
        router: fieldRouter((p: any) => p.workflowId),
        transform: directTransform((p: any) => ({
          type: p.eventType ?? "webhook.received",
          payload: p,
        })),
      },
    ],
  });

  it("dispatches event for valid request", async () => {
    const body = JSON.stringify({ workflowId: "wf-1", eventType: "APPROVE" });
    const res = await app.request("/webhooks/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.dispatched).toBe(1);

    expect(client.sends).toHaveLength(1);
    expect(client.sends[0].workflowId).toBe("wf-1");
    expect(client.sends[0].message).toEqual({
      type: "APPROVE",
      payload: { workflowId: "wf-1", eventType: "APPROVE" },
    });
    expect(client.sends[0].topic).toBe("xstate.event");
  });

  it("returns 422 when route returns null", async () => {
    const body = JSON.stringify({ noWorkflowId: true });
    const res = await app.request("/webhooks/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(422);
    const json = await res.json() as any;
    expect(json.error).toContain("No target workflow");
  });

  it("returns 401 for verification failure", async () => {
    const failSource: WebhookSource<unknown> = {
      async verify(_req: RawRequest) {
        throw new WebhookVerificationError("Bad sig", "test");
      },
      async parse(req: RawRequest) {
        return JSON.parse(req.body);
      },
    };

    const failApp = createWebhookGateway({
      client,
      bindings: [
        {
          path: "/webhooks/fail",
          source: failSource,
          router: fieldRouter(() => "wf-1"),
          transform: directTransform(() => ({ type: "TEST" })),
        },
      ],
    });

    const res = await failApp.request("/webhooks/fail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(401);
    const json = await res.json() as any;
    expect(json.error).toBe("Bad sig");
    expect(json.source).toBe("test");
  });

  it("dispatches to multiple workflow IDs", async () => {
    const multiApp = createWebhookGateway({
      client,
      bindings: [
        {
          path: "/webhooks/multi",
          source: genericSource(),
          router: fieldRouter((p: any) => p.ids),
          transform: directTransform(() => ({ type: "NOTIFY" })),
        },
      ],
    });

    const body = JSON.stringify({ ids: ["wf-a", "wf-b", "wf-c"] });
    const res = await multiApp.request("/webhooks/multi", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.dispatched).toBe(3);
    expect(client.sends).toHaveLength(3);
    expect(client.sends.map((s) => s.workflowId)).toEqual(["wf-a", "wf-b", "wf-c"]);
  });

  it("supports basePath option", async () => {
    const prefixApp = createWebhookGateway({
      client,
      basePath: "/api/v1",
      bindings: [
        {
          path: "/hooks",
          source: genericSource(),
          router: fieldRouter(() => "wf-1"),
          transform: directTransform(() => ({ type: "PING" })),
        },
      ],
    });

    const res = await prefixApp.request("/api/v1/hooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(client.sends).toHaveLength(1);
  });

  it("returns 404 for unregistered path", async () => {
    const res = await app.request("/webhooks/unknown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(404);
  });
});
