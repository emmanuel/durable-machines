import { describe, it, expect } from "vitest";
import { createWorkerMetrics } from "../../src/metrics.js";

describe("createWorkerMetrics", () => {
  it("creates all expected metric instruments", () => {
    const metrics = createWorkerMetrics();

    expect(metrics.machineRegistrationDuration).toBeDefined();
    expect(metrics.backendStartDuration).toBeDefined();
    expect(metrics.eventsProcessedTotal).toBeDefined();
    expect(metrics.eventProcessDuration).toBeDefined();
    expect(metrics.activeDispatches).toBeDefined();
    expect(metrics.effectsExecutedTotal).toBeDefined();
    expect(metrics.effectExecutionDuration).toBeDefined();
    expect(metrics.pollItemsFound).toBeDefined();
  });

  it("exposes a metricsHandler function", () => {
    const metrics = createWorkerMetrics();
    expect(metrics.metricsHandler).toBeTypeOf("function");
  });
});
