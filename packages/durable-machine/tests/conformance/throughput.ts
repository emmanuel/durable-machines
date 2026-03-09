import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, assign, fromPromise } from "xstate";
import { durableState } from "../../src/durable-state.js";
import type { BackendFixture } from "../fixtures/helpers.js";
import { waitForContext } from "../fixtures/helpers.js";

export function throughputConformance(backend: BackendFixture) {
  describe(`throughput [${backend.name}]`, () => {
    const logicOnlyMachine = setup({
      types: {
        context: {} as { count: number },
        events: {} as { type: "NEXT" } | { type: "FINISH" },
        input: {} as Record<string, never>,
      },
    }).createMachine({
      id: "throughput-logic",
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

    const blendedMachine = setup({
      types: {
        context: {} as { count: number },
        events: {} as
          | { type: "NEXT" }
          | { type: "WORK" }
          | { type: "FINISH" },
        input: {} as Record<string, never>,
      },
      actors: { fastWork: fromPromise(async () => "ok") },
    }).createMachine({
      id: "throughput-blended",
      initial: "waiting",
      context: { count: 0 },
      states: {
        waiting: {
          ...durableState(),
          on: {
            NEXT: {
              actions: assign({
                count: ({ context }) => context.count + 1,
              }),
            },
            WORK: "invoking",
            FINISH: "done",
          },
        },
        invoking: {
          invoke: {
            src: "fastWork",
            onDone: "waiting",
            onError: "waiting",
          },
        },
        done: { type: "final" },
      },
    });

    let logicDurable: ReturnType<BackendFixture["createMachine"]>;
    let blendedDurable: ReturnType<BackendFixture["createMachine"]>;

    beforeAll(async () => {
      await backend.setup();
      logicDurable = backend.createMachine(logicOnlyMachine);
      blendedDurable = backend.createMachine(blendedMachine);
    });
    afterAll(() => backend.teardown());

    it("measures sequential logic events on a single instance", async () => {
      const N = 100;
      const handle = await logicDurable.start(`tp-seq-${Date.now()}`, {});
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        await handle.send({ type: "NEXT" });
      }
      const elapsed = performance.now() - start;
      const eventsPerSec = (N / elapsed) * 1000;
      console.log(
        `[${backend.name}] Sequential logic (1 instance): ${eventsPerSec.toFixed(0)} events/sec (${N} events in ${elapsed.toFixed(0)}ms)`,
      );
      const state = await handle.getState();
      expect(state!.context).toMatchObject({ count: N });
    });

    it("measures burst of logic events (batch drain)", async () => {
      const N = 100;
      const id = `tp-burst-${Date.now()}`;
      const handle = await logicDurable.start(id, {});

      // Fire all sends concurrently — they append to event_log in parallel
      const sends = Array.from({ length: N }, () =>
        handle.send({ type: "NEXT" }),
      );
      const start = performance.now();
      await Promise.all(sends);
      // Wait for all events to be processed
      await waitForContext(handle, (ctx) => ctx.count >= N, 30000);
      const elapsed = performance.now() - start;
      const eventsPerSec = (N / elapsed) * 1000;
      console.log(
        `[${backend.name}] Burst drain (1 instance, ${N} events): ${eventsPerSec.toFixed(0)} events/sec (${elapsed.toFixed(0)}ms)`,
      );
      const state = await handle.getState();
      expect(state!.context).toMatchObject({ count: N });
    });

    it("measures concurrent instances (aggregate throughput)", async () => {
      const INSTANCES = 20;
      const EVENTS_PER = 10;
      const handles = await Promise.all(
        Array.from({ length: INSTANCES }, (_, i) =>
          logicDurable.start(`tp-agg-${Date.now()}-${i}`, {}),
        ),
      );
      const start = performance.now();
      await Promise.all(
        handles.map(async (h) => {
          for (let i = 0; i < EVENTS_PER; i++) {
            await h.send({ type: "NEXT" });
          }
        }),
      );
      const elapsed = performance.now() - start;
      const total = INSTANCES * EVENTS_PER;
      const eventsPerSec = (total / elapsed) * 1000;
      console.log(
        `[${backend.name}] Aggregate (${INSTANCES}×${EVENTS_PER}): ${eventsPerSec.toFixed(0)} events/sec (${total} events in ${elapsed.toFixed(0)}ms)`,
      );
      // Verify all reached correct count
      for (const h of handles) {
        const s = await h.getState();
        expect(s!.context).toMatchObject({ count: EVENTS_PER });
      }
    });

    it("measures concurrent instances at scale (aggregate throughput)", async () => {
      const INSTANCES = 20;
      const EVENTS_PER = 100;
      const handles = await Promise.all(
        Array.from({ length: INSTANCES }, (_, i) =>
          logicDurable.start(`tp-agg2-${Date.now()}-${i}`, {}),
        ),
      );
      const start = performance.now();
      await Promise.all(
        handles.map(async (h) => {
          for (let i = 0; i < EVENTS_PER; i++) {
            await h.send({ type: "NEXT" });
          }
        }),
      );
      const elapsed = performance.now() - start;
      const total = INSTANCES * EVENTS_PER;
      const eventsPerSec = (total / elapsed) * 1000;
      console.log(
        `[${backend.name}] Aggregate (${INSTANCES}×${EVENTS_PER}): ${eventsPerSec.toFixed(0)} events/sec (${total} events in ${elapsed.toFixed(0)}ms)`,
      );
      for (const h of handles) {
        const s = await h.getState();
        expect(s!.context).toMatchObject({ count: EVENTS_PER });
      }
    });

    it("measures concurrent instances at XL scale (aggregate throughput)", async () => {
      const INSTANCES = 20;
      const EVENTS_PER = 1000;
      const handles = await Promise.all(
        Array.from({ length: INSTANCES }, (_, i) =>
          logicDurable.start(`tp-agg3-${Date.now()}-${i}`, {}),
        ),
      );
      const start = performance.now();
      await Promise.all(
        handles.map(async (h) => {
          for (let i = 0; i < EVENTS_PER; i++) {
            await h.send({ type: "NEXT" });
          }
        }),
      );
      const elapsed = performance.now() - start;
      const total = INSTANCES * EVENTS_PER;
      const eventsPerSec = (total / elapsed) * 1000;
      console.log(
        `[${backend.name}] Aggregate (${INSTANCES}×${EVENTS_PER}): ${eventsPerSec.toFixed(0)} events/sec (${total} events in ${elapsed.toFixed(0)}ms)`,
      );
      for (const h of handles) {
        const s = await h.getState();
        expect(s!.context).toMatchObject({ count: EVENTS_PER });
      }
    }, 60_000);

    it("measures blended throughput (3:1 logic:IO)", async () => {
      const ROUNDS = 5;
      const id = `tp-blended-${Date.now()}`;
      const handle = await blendedDurable.start(id, {});

      const start = performance.now();
      for (let r = 0; r < ROUNDS; r++) {
        for (let i = 0; i < 3; i++) {
          await handle.send({ type: "NEXT" });
        }
        await handle.send({ type: "WORK" });
        // Wait for invoke to complete and return to waiting
        await waitForContext(
          handle,
          (ctx) => ctx.count >= (r + 1) * 3,
          10000,
        );
      }
      const elapsed = performance.now() - start;
      const totalEvents = ROUNDS * 4; // 3 NEXT + 1 WORK per round
      const eventsPerSec = (totalEvents / elapsed) * 1000;
      console.log(
        `[${backend.name}] Blended 3:1 (${ROUNDS} rounds): ${eventsPerSec.toFixed(0)} events/sec (${totalEvents} events in ${elapsed.toFixed(0)}ms)`,
      );
      const state = await handle.getState();
      expect(state!.context).toMatchObject({ count: ROUNDS * 3 });
    });
  });
}
