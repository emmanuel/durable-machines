import { Registry, Histogram, Counter, Gauge, collectDefaultMetrics } from "prom-client";

export interface WorkerMetrics {
  registry: Registry;
  // Startup
  machineRegistrationDuration: Histogram;
  backendStartDuration: Histogram;
  // Runtime — event processing
  eventsProcessedTotal: Counter;
  eventProcessDuration: Histogram;
  activeDispatches: Gauge;
  // Runtime — effects
  effectsExecutedTotal: Counter;
  effectExecutionDuration: Histogram;
  // Runtime — polling
  pollItemsFound: Counter;
}

export function createWorkerMetrics(registry?: Registry): WorkerMetrics {
  const reg = registry ?? new Registry();

  const machineRegistrationDuration = new Histogram({
    name: "worker_machine_registration_duration_seconds",
    help: "Duration of machine registration (validate + register DBOS workflow)",
    labelNames: ["machine_id"] as const,
    registers: [reg],
  });

  const backendStartDuration = new Histogram({
    name: "worker_backend_start_duration_seconds",
    help: "Duration of backend start (DBOS launch, PG schema init, etc.)",
    registers: [reg],
  });

  const eventsProcessedTotal = new Counter({
    name: "worker_events_processed_total",
    help: "Total events dispatched and processed",
    labelNames: ["machine_id", "status"] as const,
    registers: [reg],
  });

  const eventProcessDuration = new Histogram({
    name: "worker_event_process_duration_seconds",
    help: "Duration of event processing (consumeAndProcess)",
    labelNames: ["machine_id"] as const,
    registers: [reg],
  });

  const activeDispatches = new Gauge({
    name: "worker_active_dispatches",
    help: "Number of currently in-flight dispatch operations",
    registers: [reg],
  });

  const effectsExecutedTotal = new Counter({
    name: "worker_effects_executed_total",
    help: "Total effects claimed and executed",
    labelNames: ["effect_type", "status"] as const,
    registers: [reg],
  });

  const effectExecutionDuration = new Histogram({
    name: "worker_effect_execution_duration_seconds",
    help: "Duration of individual effect execution",
    labelNames: ["effect_type"] as const,
    registers: [reg],
  });

  const pollItemsFound = new Counter({
    name: "worker_poll_items_found_total",
    help: "Total items found by adaptive pollers",
    labelNames: ["poll_type"] as const,
    registers: [reg],
  });

  collectDefaultMetrics({ register: reg });

  return {
    registry: reg,
    machineRegistrationDuration,
    backendStartDuration,
    eventsProcessedTotal,
    eventProcessDuration,
    activeDispatches,
    effectsExecutedTotal,
    effectExecutionDuration,
    pollItemsFound,
  };
}
