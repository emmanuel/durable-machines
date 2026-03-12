import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeVizMachine } from "../fixtures/machines.js";
import { waitForState } from "../fixtures/helpers.js";
import type { BackendFixture } from "../fixtures/helpers.js";

export function vizConformance(backend: BackendFixture) {
  if (!backend.getVisualizationState) {
    describe.skip(`visualization [${backend.name}] (not supported)`, () => {});
    return;
  }

  const getVizState = backend.getVisualizationState.bind(backend);

  describe(`visualization [${backend.name}]`, () => {
    const vizMachine = makeVizMachine("vizOrder");
    const vizMachineNoStream = makeVizMachine("vizOrderNoStream");

    const durable = backend.createMachine(vizMachine, {
      enableAnalytics: true,
    });
    const durableNoStream = backend.createMachine(vizMachineNoStream);

    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());

    it("returns definition, current state, and transitions for a completed workflow", async () => {
      const id = `viz-complete-${Date.now()}`;
      const handle = await durable.start(id, { orderId: "v1", total: 42 });

      await waitForState(handle, "pending");
      await handle.send({ type: "PAY" });
      const result = await handle.getResult();
      expect(result).toMatchObject({ chargeId: "ch_42" });

      const viz = await getVizState(vizMachine, id);

      expect(viz.definition.id).toBe("vizOrder");
      expect(viz.definition.initial).toBe("pending");
      expect(viz.definition.states["pending"].durable).toBe(true);

      expect(viz.currentState).not.toBeNull();
      expect(viz.currentState!.status).toBe("done");

      expect(viz.transitions.length).toBeGreaterThanOrEqual(2);
      expect(viz.transitions[0].from).toBeNull();
      expect(viz.transitions[0].to).toBe("pending");

      expect(viz.stateDurations.length).toBe(viz.transitions.length);
    });

    it("returns empty transitions when stream is not enabled", async () => {
      const id = `viz-no-stream-${Date.now()}`;
      const handle = await durableNoStream.start(id, {
        orderId: "v2",
        total: 10,
      });

      await waitForState(handle, "pending");
      await handle.send({ type: "CANCEL" });
      await handle.getResult();

      const viz = await getVizState(vizMachineNoStream, id);

      expect(viz.definition.id).toBe("vizOrderNoStream");
      expect(viz.currentState).not.toBeNull();
      expect(viz.transitions).toEqual([]);
      expect(viz.stateDurations).toEqual([]);
    });

    it("shows current state and no active sleep for a durable machine", async () => {
      const id = `viz-durable-${Date.now()}`;
      const handle = await durable.start(id, { orderId: "v3", total: 20 });

      await waitForState(handle, "pending");

      const viz = await getVizState(vizMachine, id);

      expect(viz.currentState).not.toBeNull();
      expect(viz.currentState!.value).toBe("pending");
      expect(viz.currentState!.status).toBe("running");
      expect(viz.activeSleep).toBeNull();

      await handle.send({ type: "CANCEL" });
      await handle.getResult();
    });
  });
}
