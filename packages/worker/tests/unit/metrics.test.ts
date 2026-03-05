import { describe, it, expect } from "vitest";
import { createWorkerMetrics } from "../../src/metrics.js";
import { Registry } from "prom-client";

describe("createWorkerMetrics", () => {
  it("creates a registry with both expected metrics", async () => {
    const { registry } = createWorkerMetrics();
    const text = await registry.metrics();

    expect(text).toContain("worker_machine_registration_duration_seconds");
    expect(text).toContain("worker_dbos_launch_duration_seconds");
  });

  it("uses an existing registry when provided", async () => {
    const existing = new Registry();
    const { registry } = createWorkerMetrics(existing);

    expect(registry).toBe(existing);
    const text = await registry.metrics();
    expect(text).toContain("worker_machine_registration_duration_seconds");
  });

  it("exposes machineRegistrationDuration and launchDuration histograms", () => {
    const metrics = createWorkerMetrics();

    expect(metrics.machineRegistrationDuration).toBeDefined();
    expect(metrics.launchDuration).toBeDefined();
  });
});
