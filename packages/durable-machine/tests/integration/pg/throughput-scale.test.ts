import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { setup, assign } from "xstate";
import { metrics } from "@opentelemetry/api";
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
  DataPointType,
} from "@opentelemetry/sdk-metrics";
import type { ResourceMetrics, HistogramMetricData } from "@opentelemetry/sdk-metrics";
import { durableState } from "../../../src/durable-state.js";
import { createPgFixture } from "./fixture.js";
import { snapshotPgStats, diffPgStats, formatPgStats } from "./pg-stat-collector.js";
import { TEST_DB_URL } from "../../test-db.js";

/**
 * Scaled throughput benchmarks — tests pool size and concurrency limiting
 * at instance counts (50, 100) where pool exhaustion becomes real.
 *
 * Instruments the PG store with OTel metrics and queries pg_stat views
 * for full visibility into query timing, pool utilization, and PG internals.
 */

const machine = setup({
  types: {
    context: {} as { count: number },
    events: {} as { type: "NEXT" } | { type: "FINISH" },
    input: {} as Record<string, never>,
  },
}).createMachine({
  id: "scale-throughput",
  initial: "counting",
  context: { count: 0 },
  states: {
    counting: {
      ...durableState(),
      on: {
        NEXT: {
          actions: assign({
            count: ({ context }) => context.count + 1,
          }),
        },
        FINISH: "done",
      },
    },
    done: { type: "final" },
  },
});

// ── Semaphore ────────────────────────────────────────────────────────────────

function createSemaphore(maxPermits: number) {
  let permits = maxPermits;
  const waitQueue: Array<() => void> = [];

  return {
    async acquire(): Promise<void> {
      if (permits > 0) {
        permits--;
        return;
      }
      return new Promise<void>((resolve) => waitQueue.push(resolve));
    },
    release(): void {
      const next = waitQueue.shift();
      if (next) next();
      else permits++;
    },
  };
}

// ── OTel metric extraction ──────────────────────────────────────────────────

interface HistogramStats {
  count: number;
  avg: number;
  min: number;
  max: number;
}

function extractHistograms(
  resourceMetrics: ResourceMetrics[],
): Map<string, Map<string, HistogramStats>> {
  const result = new Map<string, Map<string, HistogramStats>>();

  for (const rm of resourceMetrics) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if (metric.dataPointType !== DataPointType.HISTOGRAM) continue;
        const hm = metric as HistogramMetricData;
        const byAttr = new Map<string, HistogramStats>();
        for (const dp of hm.dataPoints) {
          const key = Object.entries(dp.attributes)
            .map(([k, v]) => `${k}=${v}`)
            .join(",") || "_all";
          byAttr.set(key, {
            count: dp.value.count,
            avg: dp.value.count > 0 ? (dp.value.sum ?? 0) / dp.value.count : 0,
            min: dp.value.min ?? 0,
            max: dp.value.max ?? 0,
          });
        }
        result.set(metric.descriptor.name, byAttr);
      }
    }
  }

  return result;
}

function formatHistogram(name: string, stats: HistogramStats, unit = "ms"): string {
  return `${name} avg=${stats.avg.toFixed(1)}${unit} max=${stats.max.toFixed(1)}${unit} (n=${stats.count})`;
}

function logMetricsSummary(label: string, histograms: Map<string, Map<string, HistogramStats>>) {
  const queryDurations = histograms.get("store.query.duration");
  if (queryDurations && queryDurations.size > 0) {
    const parts: string[] = [];
    for (const [attr, stats] of queryDurations) {
      const queryName = attr.replace("query=", "").replace("dm_", "");
      parts.push(`${queryName} avg=${stats.avg.toFixed(1)}ms max=${stats.max.toFixed(1)}ms`);
    }
    console.log(`  [${label}] Queries: ${parts.join(" | ")}`);
  }

  const checkout = histograms.get("store.pool.checkout_duration");
  if (checkout) {
    const stats = checkout.get("_all");
    if (stats) {
      console.log(`  [${label}] Pool: ${formatHistogram("checkout", stats)}`);
    }
  }

  const batchSize = histograms.get("store.batch.size");
  if (batchSize) {
    const stats = batchSize.get("_all");
    if (stats) {
      console.log(`  [${label}] Batch: avg=${stats.avg.toFixed(1)} events/batch max=${stats.max.toFixed(0)}`);
    }
  }
}

// ── Benchmark runner ─────────────────────────────────────────────────────────

interface ScaleConfig {
  poolSize: number;
  maxConcurrency: number;
}

function runScaleSuite(config: ScaleConfig) {
  const { poolSize, maxConcurrency } = config;
  const label = `pool=${poolSize} conc=${maxConcurrency}`;
  const fixture = createPgFixture({ poolSize, enableMetrics: true });

  let exporter: InMemoryMetricExporter;
  let provider: MeterProvider;
  let statPool: pg.Pool;

  describe(`scale throughput [${label}]`, () => {
    let dm: ReturnType<typeof fixture.createMachine>;

    beforeAll(async () => {
      // Separate single-connection pool for pg_stat queries
      statPool = new pg.Pool({ connectionString: TEST_DB_URL, max: 1 });

      // Set up OTel metrics provider before creating the machine
      // so createStoreInstruments() picks up the real provider
      exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 600_000, // Long interval — we flush manually
      });
      provider = new MeterProvider({ readers: [reader] });
      metrics.setGlobalMeterProvider(provider);

      await fixture.setup();
      dm = fixture.createMachine(machine);
    });

    afterAll(async () => {
      await fixture.teardown();
      await provider.shutdown();
      await statPool.end();
      metrics.disable();
    });

    async function runBenchmark(instances: number, eventsPerInstance: number) {
      const sem = createSemaphore(maxConcurrency);

      exporter.reset();
      const pgBefore = await snapshotPgStats(statPool);

      const handles = await Promise.all(
        Array.from({ length: instances }, (_, i) =>
          dm.start(`scale-${instances}x${eventsPerInstance}-${label}-${Date.now()}-${i}`, {}),
        ),
      );

      const start = performance.now();
      await Promise.all(
        handles.map(async (h) => {
          for (let i = 0; i < eventsPerInstance; i++) {
            await sem.acquire();
            try {
              await h.send({ type: "NEXT" });
            } finally {
              sem.release();
            }
          }
        }),
      );
      const elapsed = performance.now() - start;
      const total = instances * eventsPerInstance;
      const eventsPerSec = (total / elapsed) * 1000;

      console.log(
        `[${label}] Aggregate (${instances}×${eventsPerInstance}): ${eventsPerSec.toFixed(0)} events/sec (${total} events in ${elapsed.toFixed(0)}ms)`,
      );

      // Collect OTel metrics
      await provider.forceFlush();
      const histograms = extractHistograms(exporter.getMetrics());
      logMetricsSummary(label, histograms);

      // Collect pg_stat
      const pgAfter = await snapshotPgStats(statPool);
      const pgDiff = diffPgStats(pgBefore, pgAfter);
      console.log(`  [${label}] ${formatPgStats(pgDiff)}`);

      // Verify correctness
      for (const h of handles) {
        const s = await h.getState();
        expect(s!.context).toMatchObject({ count: eventsPerInstance });
      }
    }

    it(`50×1000 [${label}]`, () => runBenchmark(50, 1000), 120_000);
    it(`100×1000 [${label}]`, () => runBenchmark(100, 1000), 300_000);
  });
}

// ── Matrix ───────────────────────────────────────────────────────────────────

const configs: ScaleConfig[] = [
  { poolSize: 20, maxConcurrency: 10 },
  { poolSize: 30, maxConcurrency: 20 },
  { poolSize: 50, maxConcurrency: 30 },
];

for (const config of configs) {
  runScaleSuite(config);
}
