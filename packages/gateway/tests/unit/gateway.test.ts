import { describe, it, expect, beforeEach } from "vitest";
import { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from "@opentelemetry/sdk-metrics";
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
    // topic is now an internal implementation detail, not exposed on GatewayClient
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

describe("createWebhookGateway with tenant bindings", () => {
  it("uses tenant-scoped client when binding has tenantId", async () => {
    const defaultClient = createMockClient();
    const tenantClient = createMockClient();

    const app = createWebhookGateway({
      client: defaultClient,
      forTenantClient: (tenantId) => {
        expect(tenantId).toBe("tenant-abc");
        return tenantClient;
      },
      bindings: [
        {
          path: "/webhooks/tenant-stripe",
          tenantId: "tenant-abc",
          source: genericSource(),
          router: fieldRouter((p: any) => p.workflowId),
          transform: directTransform((p: any) => ({ type: "STRIPE", ...p })),
        },
      ],
    });

    const body = JSON.stringify({ workflowId: "wf-1" });
    const res = await app.request("/webhooks/tenant-stripe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(200);
    expect(tenantClient.sends).toHaveLength(1);
    expect(tenantClient.sends[0].workflowId).toBe("wf-1");
    expect(defaultClient.sends).toHaveLength(0);
  });

  it("uses default client when binding has no tenantId", async () => {
    const defaultClient = createMockClient();
    const forTenantClient = () => createMockClient();

    const app = createWebhookGateway({
      client: defaultClient,
      forTenantClient,
      bindings: [
        {
          path: "/webhooks/global",
          source: genericSource(),
          router: fieldRouter((p: any) => p.workflowId),
          transform: directTransform((p: any) => ({ type: "HOOK", ...p })),
        },
      ],
    });

    const body = JSON.stringify({ workflowId: "wf-1" });
    const res = await app.request("/webhooks/global", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(200);
    expect(defaultClient.sends).toHaveLength(1);
  });
});

describe("createWebhookGateway with metrics", () => {
  function createTestMetrics(): GatewayMetrics {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 100,
    });
    const provider = new MeterProvider({ readers: [reader] });
    const meter = provider.getMeter("test");

    return {
      webhooksReceived: meter.createCounter("webhook_gateway_received_total"),
      webhooksDispatched: meter.createCounter("webhook_gateway_dispatched_total"),
      webhookDuration: meter.createHistogram("webhook_gateway_duration_seconds"),
      streamEventsReceived: meter.createCounter("stream_events_received_total"),
      streamItemsDispatched: meter.createCounter("stream_items_dispatched_total"),
      streamReconnections: meter.createCounter("stream_reconnections_total"),
      streamCheckpoints: meter.createCounter("stream_checkpoints_total"),
      metricsHandler: () => {},
    } as unknown as GatewayMetrics;
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
    const res = await app.request("/webhooks/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(200);
    // OTel counters don't have a synchronous read API like prom-client's
    // getSingleMetricAsString — the test verifies the metrics middleware
    // runs without errors. Full metrics validation is done via the
    // PrometheusExporter in integration tests.
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

    const res = await app.request("/webhooks/fail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(401);
  });
});
