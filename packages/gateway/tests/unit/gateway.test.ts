import { describe, it, expect, beforeEach } from "vitest";
import { Registry, Counter, Histogram } from "prom-client";
import { createWebhookGateway } from "../../src/gateway.js";
import { genericSource } from "../../src/sources/generic.js";
import { fieldRouter } from "../../src/routers/field.js";
import { directTransform } from "../../src/transforms/direct.js";
import { createMockClient } from "../helpers/mock-client.js";
import { WebhookVerificationError } from "../../src/types.js";
import type { WebhookSource, RawRequest } from "../../src/types.js";
import type { GatewayMetrics } from "../../src/metrics.js";

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

  it("returns 422 when parse returns empty array", async () => {
    const emptyApp = createWebhookGateway({
      client,
      bindings: [
        {
          path: "/webhooks/empty",
          source: genericSource(),
          parse: () => [],
          router: { route: () => "wf-1" },
          transform: { transform: () => ({ type: "NOOP" }) },
        },
      ],
    });

    const res = await emptyApp.request("/webhooks/empty", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(422);
    const json = await res.json() as any;
    expect(json.error).toContain("No target workflow");
    expect(client.sends).toHaveLength(0);
  });

  it("fires and forgets item dispatch when onResponse is set", async () => {
    const onResponseApp = createWebhookGateway({
      client,
      bindings: [
        {
          path: "/webhooks/ack",
          source: genericSource(),
          parse: (p: { items: Array<{ id: string; wfId: string }> }) => p.items,
          router: { route: (item: { id: string; wfId: string }) => item.wfId },
          transform: { transform: (item: { id: string; wfId: string }) => ({ type: "ACK", id: item.id }) },
          onResponse(_payload, c) {
            return c.json({ acked: true });
          },
        },
      ],
    });

    const body = JSON.stringify({
      items: [
        { id: "x", wfId: "wf-1" },
        { id: "y", wfId: "wf-2" },
      ],
    });
    const res = await onResponseApp.request("/webhooks/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.acked).toBe(true);

    // Fire-and-forget completes async
    await new Promise((r) => setTimeout(r, 10));
    expect(client.sends).toHaveLength(2);
    expect(client.sends.map((s) => s.workflowId)).toEqual(["wf-1", "wf-2"]);
  });

  it("dispatches per-item via parse fan-out", async () => {
    interface Batch {
      items: Array<{ id: string; wfId: string }>;
    }
    const parseApp = createWebhookGateway({
      client,
      bindings: [
        {
          path: "/webhooks/batch",
          source: genericSource(),
          parse: (payload: Batch) => payload.items,
          router: { route: (item: { id: string; wfId: string }) => item.wfId },
          transform: { transform: (item: { id: string; wfId: string }) => ({ type: "ITEM", id: item.id }) },
        },
      ],
    });

    const body = JSON.stringify({
      items: [
        { id: "a", wfId: "wf-1" },
        { id: "b", wfId: "wf-2" },
        { id: "c", wfId: "wf-1" },
      ],
    });
    const res = await parseApp.request("/webhooks/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.dispatched).toBe(3);
    expect(client.sends).toHaveLength(3);
    expect(client.sends.map((s) => s.workflowId)).toEqual(["wf-1", "wf-2", "wf-1"]);
  });
});

describe("createWebhookGateway with metrics", () => {
  function createTestMetrics(): GatewayMetrics {
    const registry = new Registry();
    const webhooksReceived = new Counter({
      name: "webhook_gateway_received_total",
      help: "Total webhooks received",
      labelNames: ["path", "status"] as const,
      registers: [registry],
    });
    const webhooksDispatched = new Counter({
      name: "webhook_gateway_dispatched_total",
      help: "Total webhooks dispatched",
      labelNames: ["path"] as const,
      registers: [registry],
    });
    const webhookDuration = new Histogram({
      name: "webhook_gateway_duration_seconds",
      help: "Webhook duration",
      labelNames: ["path"] as const,
      registers: [registry],
    });
    const streamEventsReceived = new Counter({
      name: "stream_events_received_total",
      help: "Stream events received",
      labelNames: ["streamId"] as const,
      registers: [registry],
    });
    const streamItemsDispatched = new Counter({
      name: "stream_items_dispatched_total",
      help: "Stream items dispatched",
      labelNames: ["streamId"] as const,
      registers: [registry],
    });
    const streamReconnections = new Counter({
      name: "stream_reconnections_total",
      help: "Stream reconnections",
      labelNames: ["streamId"] as const,
      registers: [registry],
    });
    const streamCheckpoints = new Counter({
      name: "stream_checkpoints_total",
      help: "Stream checkpoints",
      labelNames: ["streamId"] as const,
      registers: [registry],
    });
    return {
      registry,
      webhooksReceived,
      webhooksDispatched,
      webhookDuration,
      streamEventsReceived,
      streamItemsDispatched,
      streamReconnections,
      streamCheckpoints,
    };
  }

  it("increments received and dispatched on successful dispatch", async () => {
    const client = createMockClient();
    const metrics = createTestMetrics();

    const app = createWebhookGateway({
      client,
      metrics,
      bindings: [
        {
          path: "/webhooks/test",
          source: genericSource(),
          router: fieldRouter((p: any) => p.workflowId),
          transform: directTransform((p: any) => ({ type: p.event ?? "TEST" })),
        },
      ],
    });

    const body = JSON.stringify({ workflowId: "wf-1", event: "APPROVE" });
    await app.request("/webhooks/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const received = await metrics.registry.getSingleMetricAsString(
      "webhook_gateway_received_total",
    );
    expect(received).toContain('path="/webhooks/test"');
    expect(received).toContain('status="200"');

    const dispatched = await metrics.registry.getSingleMetricAsString(
      "webhook_gateway_dispatched_total",
    );
    expect(dispatched).toContain('path="/webhooks/test"');
  });

  it("increments received with error status on verification failure", async () => {
    const client = createMockClient();
    const metrics = createTestMetrics();

    const failSource: WebhookSource<unknown> = {
      async verify() {
        throw new WebhookVerificationError("Bad sig", "test");
      },
      async parse(req: RawRequest) {
        return JSON.parse(req.body);
      },
    };

    const app = createWebhookGateway({
      client,
      metrics,
      bindings: [
        {
          path: "/webhooks/fail",
          source: failSource,
          router: fieldRouter(() => "wf-1"),
          transform: directTransform(() => ({ type: "TEST" })),
        },
      ],
    });

    await app.request("/webhooks/fail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const received = await metrics.registry.getSingleMetricAsString(
      "webhook_gateway_received_total",
    );
    expect(received).toContain('status="401"');

    // dispatched should NOT be incremented
    const dispatched = await metrics.registry.getSingleMetricAsString(
      "webhook_gateway_dispatched_total",
    );
    expect(dispatched).not.toContain('path="/webhooks/fail"');
  });
});
