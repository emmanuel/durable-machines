import { describe, it, expect } from "vitest";
import { createWorkerMetrics } from "../../src/metrics.js";
import { Registry } from "prom-client";

describe("createWorkerMetrics", () => {
  it("creates a registry with all expected metrics", async () => {
    const { registry } = createWorkerMetrics();
    const text = await registry.metrics();

    // Startup metrics
    expect(text).toContain("worker_machine_registration_duration_seconds");
    expect(text).toContain("worker_backend_start_duration_seconds");

    // Runtime metrics
    expect(text).toContain("worker_events_processed_total");
    expect(text).toContain("worker_event_process_duration_seconds");
    expect(text).toContain("worker_active_dispatches");
    expect(text).toContain("worker_effects_executed_total");
    expect(text).toContain("worker_effect_execution_duration_seconds");
    expect(text).toContain("worker_poll_items_found_total");
  });

  it("uses an existing registry when provided", async () => {
    const existing = new Registry();
    const { registry } = createWorkerMetrics(existing);

    expect(registry).toBe(existing);
    const text = await registry.metrics();
    expect(text).toContain("worker_machine_registration_duration_seconds");
  });

  it("exposes startup histograms", () => {
    const metrics = createWorkerMetrics();

    expect(metrics.machineRegistrationDuration).toBeDefined();
    expect(metrics.backendStartDuration).toBeDefined();
  });

  it("exposes runtime counters, histograms, and gauge", () => {
    const metrics = createWorkerMetrics();

    expect(metrics.eventsProcessedTotal).toBeDefined();
    expect(metrics.eventProcessDuration).toBeDefined();
    expect(metrics.activeDispatches).toBeDefined();
    expect(metrics.effectsExecutedTotal).toBeDefined();
    expect(metrics.effectExecutionDuration).toBeDefined();
    expect(metrics.pollItemsFound).toBeDefined();
  });
});
