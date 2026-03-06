import { Registry, Counter, Histogram, collectDefaultMetrics } from "prom-client";

export interface GatewayMetrics {
  registry: Registry;
  webhooksReceived: Counter;
  webhooksDispatched: Counter;
  webhookDuration: Histogram;
  /** Total SSE/stream events received (labeled: streamId). */
  streamEventsReceived: Counter;
  /** Total items dispatched from streams (labeled: streamId). */
  streamItemsDispatched: Counter;
  /** Total stream reconnections (labeled: streamId). */
  streamReconnections: Counter;
  /** Total checkpoint writes (labeled: streamId). */
  streamCheckpoints: Counter;
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

  const streamEventsReceived = new Counter({
    name: "stream_events_received_total",
    help: "Total SSE/stream events received",
    labelNames: ["streamId"] as const,
    registers: [reg],
  });

  const streamItemsDispatched = new Counter({
    name: "stream_items_dispatched_total",
    help: "Total items dispatched from streams",
    labelNames: ["streamId"] as const,
    registers: [reg],
  });

  const streamReconnections = new Counter({
    name: "stream_reconnections_total",
    help: "Total stream reconnections",
    labelNames: ["streamId"] as const,
    registers: [reg],
  });

  const streamCheckpoints = new Counter({
    name: "stream_checkpoints_total",
    help: "Total checkpoint writes",
    labelNames: ["streamId"] as const,
    registers: [reg],
  });

  collectDefaultMetrics({ register: reg });

  return {
    registry: reg,
    webhooksReceived,
    webhooksDispatched,
    webhookDuration,
    streamEventsReceived,
    streamItemsDispatched,
    streamReconnections,
    streamCheckpoints,
  };
}
