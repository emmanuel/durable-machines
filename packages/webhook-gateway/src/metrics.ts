import { Registry, Counter, Histogram, collectDefaultMetrics } from "prom-client";

export interface GatewayMetrics {
  registry: Registry;
  webhooksReceived: Counter;
  webhooksDispatched: Counter;
  webhookDuration: Histogram;
}

export function createGatewayMetrics(registry?: Registry): GatewayMetrics {
  const reg = registry ?? new Registry();

  const webhooksReceived = new Counter({
    name: "webhook_gateway_received_total",
    help: "Total webhooks received",
    labelNames: ["path", "status"] as const,
    registers: [reg],
  });

  const webhooksDispatched = new Counter({
    name: "webhook_gateway_dispatched_total",
    help: "Total webhooks successfully dispatched",
    labelNames: ["path"] as const,
    registers: [reg],
  });

  const webhookDuration = new Histogram({
    name: "webhook_gateway_duration_seconds",
    help: "Webhook processing duration in seconds",
    labelNames: ["path"] as const,
    registers: [reg],
  });

  collectDefaultMetrics({ register: reg });

  return { registry: reg, webhooksReceived, webhooksDispatched, webhookDuration };
}
