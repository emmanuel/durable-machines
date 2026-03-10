import type { IncomingMessage, ServerResponse } from "node:http";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import type { Counter, Histogram } from "@opentelemetry/api";

export interface GatewayMetrics {
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
  // Admin server handler
  metricsHandler: (req: IncomingMessage, res: ServerResponse) => void;
}

export function createGatewayMetrics(): GatewayMetrics {
  const exporter = new PrometheusExporter({ preventServerStart: true });
  const provider = new MeterProvider({ readers: [exporter] });
  const meter = provider.getMeter("durable-xstate.gateway");

  const webhooksReceived = meter.createCounter(
    "webhook_gateway_received_total",
    { description: "Total webhooks received" },
  );

  const webhooksDispatched = meter.createCounter(
    "webhook_gateway_dispatched_total",
    { description: "Total webhooks successfully dispatched" },
  );

  const webhookDuration = meter.createHistogram(
    "webhook_gateway_duration_seconds",
    { description: "Webhook processing duration in seconds" },
  );

  const streamEventsReceived = meter.createCounter(
    "stream_events_received_total",
    { description: "Total SSE/stream events received" },
  );

  const streamItemsDispatched = meter.createCounter(
    "stream_items_dispatched_total",
    { description: "Total items dispatched from streams" },
  );

  const streamReconnections = meter.createCounter(
    "stream_reconnections_total",
    { description: "Total stream reconnections" },
  );

  const streamCheckpoints = meter.createCounter(
    "stream_checkpoints_total",
    { description: "Total checkpoint writes" },
  );

  return {
    webhooksReceived,
    webhooksDispatched,
    webhookDuration,
    streamEventsReceived,
    streamItemsDispatched,
    streamReconnections,
    streamCheckpoints,
    metricsHandler: (req, res) => exporter.getMetricsRequestHandler(req, res),
  };
}
