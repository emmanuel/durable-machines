import { describe, it, expect } from "vitest";
import { xapiBinding } from "../../../src/sources/xapi-binding.js";
import { createMockClient } from "../../helpers/mock-client.js";
import { createWebhookGateway } from "../../../src/gateway.js";
import type { XapiWebhookPayload } from "../../../src/sources/xapi-types.js";

describe("xapiBinding", () => {
  const client = createMockClient();

  const binding = xapiBinding({
    path: "/webhooks/xapi",
    source: {},
    router: {
      route(payload: XapiWebhookPayload) {
        const reg = payload.statements[0]?.context?.registration;
        return reg ?? null;
      },
    },
    transform: {
      transform(payload: XapiWebhookPayload) {
        const verb = payload.statements[0]?.verb.id.split("/").pop() ?? "unknown";
        return { type: `xapi.${verb}`, statements: payload.statements };
      },
    },
  });

  const app = createWebhookGateway({ client, bindings: [binding] });

  it("returns 200 with statement ID array", async () => {
    client.reset();
    const body = JSON.stringify([
      {
        id: "stmt-aaa",
        actor: { mbox: "mailto:a@example.com" },
        verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
        object: { id: "http://example.com/activity/1" },
        context: { registration: "wf-100" },
      },
      {
        id: "stmt-bbb",
        actor: { mbox: "mailto:b@example.com" },
        verb: { id: "http://adlnet.gov/expapi/verbs/attempted" },
        object: { id: "http://example.com/activity/2" },
        context: { registration: "wf-100" },
      },
    ]);

    const res = await app.request("/webhooks/xapi", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(200);
    const ids = await res.json();
    expect(ids).toEqual(["stmt-aaa", "stmt-bbb"]);
  });

  it("generates UUIDs for statements without IDs", async () => {
    client.reset();
    const body = JSON.stringify({
      actor: { mbox: "mailto:a@example.com" },
      verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
      object: { id: "http://example.com/activity/1" },
      context: { registration: "wf-200" },
    });

    const res = await app.request("/webhooks/xapi", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(200);
    const ids = (await res.json()) as string[];
    expect(ids).toHaveLength(1);
    // UUID v4 format
    expect(ids[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("dispatches event in background", async () => {
    client.reset();
    const body = JSON.stringify({
      id: "stmt-ccc",
      actor: { mbox: "mailto:a@example.com" },
      verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
      object: { id: "http://example.com/activity/1" },
      context: { registration: "wf-300" },
    });

    await app.request("/webhooks/xapi", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    // Fire-and-forget completes async
    await new Promise((r) => setTimeout(r, 10));
    expect(client.sends).toHaveLength(1);
    expect(client.sends[0].workflowId).toBe("wf-300");
    expect(client.sends[0].message).toMatchObject({ type: "xapi.completed" });
  });
});
