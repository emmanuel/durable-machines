import { metrics } from "@opentelemetry/api";
import type { Pool } from "pg";

export type StoreInstruments = ReturnType<typeof createStoreInstruments>;

export function createStoreInstruments(
  pool: Pool,
  meterName = "durable-machine.pg-store",
) {
  const meter = metrics.getMeter(meterName);

  const queryDuration = meter.createHistogram("store.query.duration", {
    description: "Duration of named store queries",
    unit: "ms",
  });

  const poolCheckoutDuration = meter.createHistogram(
    "store.pool.checkout_duration",
    {
      description: "Time waiting to acquire a pool connection",
      unit: "ms",
    },
  );

  const batchSize = meter.createHistogram("store.batch.size", {
    description: "Events processed per batch drain",
  });

  // Observable gauges for pool state — sampled on each metrics collection
  meter.createObservableGauge("store.pool.active", {
    description: "Active (checked-out) connections",
  }).addCallback((obs) => {
    obs.observe(pool.totalCount - pool.idleCount);
  });

  meter.createObservableGauge("store.pool.idle", {
    description: "Idle connections in pool",
  }).addCallback((obs) => {
    obs.observe(pool.idleCount);
  });

  meter.createObservableGauge("store.pool.waiting", {
    description: "Queued connection requests",
  }).addCallback((obs) => {
    obs.observe(pool.waitingCount);
  });

  const effectsEmittedTotal = meter.createCounter("dm_effects_emitted_total", {
    description: "Effects enqueued into the effect outbox",
  });

  return { queryDuration, poolCheckoutDuration, batchSize, effectsEmittedTotal };
}
