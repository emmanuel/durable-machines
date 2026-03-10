import type { IncomingMessage, ServerResponse } from "node:http";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import type { Counter, Histogram, UpDownCounter } from "@opentelemetry/api";

export interface WorkerMetrics {
  // Startup
  machineRegistrationDuration: Histogram;
  backendStartDuration: Histogram;
  // Runtime — event processing
  eventsProcessedTotal: Counter;
  eventProcessDuration: Histogram;
  activeDispatches: UpDownCounter;
  // Runtime — effects
  effectsExecutedTotal: Counter;
  effectExecutionDuration: Histogram;
  // Runtime — polling
  pollItemsFound: Counter;
  // Admin server handler
  metricsHandler: (req: IncomingMessage, res: ServerResponse) => void;
}

/** Start a timer that records elapsed seconds into the given histogram. */
export function startTimer(
  histogram: Histogram,
  attributes?: Record<string, string>,
): () => void {
  const start = performance.now();
  return () => histogram.record((performance.now() - start) / 1000, attributes);
}

export function createWorkerMetrics(): WorkerMetrics {
  const exporter = new PrometheusExporter({ preventServerStart: true });
  const provider = new MeterProvider({ readers: [exporter] });
  const meter = provider.getMeter("durable-xstate.worker");

  const machineRegistrationDuration = meter.createHistogram(
    "worker_machine_registration_duration_seconds",
    { description: "Duration of machine registration (validate + register workflow)" },
  );

  const backendStartDuration = meter.createHistogram(
    "worker_backend_start_duration_seconds",
    { description: "Duration of backend start (PG schema init, etc.)" },
  );

  const eventsProcessedTotal = meter.createCounter(
    "worker_events_processed_total",
    { description: "Total events dispatched and processed" },
  );

  const eventProcessDuration = meter.createHistogram(
    "worker_event_process_duration_seconds",
    { description: "Duration of event processing (consumeAndProcess)" },
  );

  const activeDispatches = meter.createUpDownCounter(
    "worker_active_dispatches",
    { description: "Number of currently in-flight dispatch operations" },
  );

  const effectsExecutedTotal = meter.createCounter(
    "worker_effects_executed_total",
    { description: "Total effects claimed and executed" },
  );

  const effectExecutionDuration = meter.createHistogram(
    "worker_effect_execution_duration_seconds",
    { description: "Duration of individual effect execution" },
  );

  const pollItemsFound = meter.createCounter(
    "worker_poll_items_found_total",
    { description: "Total items found by adaptive pollers" },
  );

  return {
    machineRegistrationDuration,
    backendStartDuration,
    eventsProcessedTotal,
    eventProcessDuration,
    activeDispatches,
    effectsExecutedTotal,
    effectExecutionDuration,
    pollItemsFound,
    metricsHandler: (req, res) => exporter.getMetricsRequestHandler(req, res),
  };
}
