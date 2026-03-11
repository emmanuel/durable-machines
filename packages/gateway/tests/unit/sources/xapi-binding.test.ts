import { describe, it, expect } from "vitest";
import { xapiBinding } from "../../../src/sources/xapi-binding.js";
import { createMockClient } from "../../helpers/mock-client.js";
import { createWebhookGateway } from "../../../src/gateway.js";

describe("xapiBinding", () => {
  const client = createMockClient();

  const binding = xapiBinding({
    path: "/webhooks/xapi",
    source: { validateAuth: async () => {} },
    router: {
      route(statement) {
        return statement.context?.registration ?? null;
      },
    },
    transform: {
      transform(statement) {
        const verb = statement.verb.id.split("/").pop() ?? "unknown";
        return { type: `xapi.${verb}`, statement };
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

  it("dispatches per-statement in background", async () => {
    client.reset();
    const body = JSON.stringify([
      {
        id: "stmt-1",
        actor: { mbox: "mailto:a@example.com" },
        verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
        object: { id: "http://example.com/activity/1" },
        context: { registration: "wf-aaa" },
      },
      {
        id: "stmt-2",
        actor: { mbox: "mailto:b@example.com" },
        verb: { id: "http://adlnet.gov/expapi/verbs/attempted" },
        object: { id: "http://example.com/activity/2" },
        context: { registration: "wf-bbb" },
      },
    ]);

    await app.request("/webhooks/xapi", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    // Fire-and-forget completes async
    await new Promise((r) => setTimeout(r, 10));
    expect(client.sends).toHaveLength(2);
    expect(client.sends[0].workflowId).toBe("wf-aaa");
    expect(client.sends[0].message).toMatchObject({ type: "xapi.completed" });
    expect(client.sends[1].workflowId).toBe("wf-bbb");
    expect(client.sends[1].message).toMatchObject({ type: "xapi.attempted" });
  });

  it("skips statements with no routable target", async () => {
    client.reset();
    const body = JSON.stringify([
      {
        id: "stmt-routable",
        actor: { mbox: "mailto:a@example.com" },
        verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
        object: { id: "http://example.com/activity/1" },
        context: { registration: "wf-target" },
      },
      {
        id: "stmt-no-reg",
        actor: { mbox: "mailto:b@example.com" },
        verb: { id: "http://adlnet.gov/expapi/verbs/attempted" },
        object: { id: "http://example.com/activity/2" },
        // no context.registration
      },
    ]);

    const res = await app.request("/webhooks/xapi", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(200);
    const ids = await res.json();
    expect(ids).toEqual(["stmt-routable", "stmt-no-reg"]);

    await new Promise((r) => setTimeout(r, 10));
    // Only the routable statement was dispatched
    expect(client.sends).toHaveLength(1);
    expect(client.sends[0].workflowId).toBe("wf-target");
  });
});
