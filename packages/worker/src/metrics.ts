import { Registry, Histogram, collectDefaultMetrics } from "prom-client";

export interface WorkerMetrics {
  registry: Registry;
  machineRegistrationDuration: Histogram;
  launchDuration: Histogram;
}

export function createWorkerMetrics(registry?: Registry): WorkerMetrics {
  const reg = registry ?? new Registry();

  const machineRegistrationDuration = new Histogram({
    name: "worker_machine_registration_duration_seconds",
    help: "Duration of machine registration (validate + register DBOS workflow)",
    labelNames: ["machine_id"] as const,
    registers: [reg],
  });

  const launchDuration = new Histogram({
    name: "worker_dbos_launch_duration_seconds",
    help: "Duration of DBOS.launch()",
    registers: [reg],
  });

  collectDefaultMetrics({ register: reg });

  return { registry: reg, machineRegistrationDuration, launchDuration };
}
