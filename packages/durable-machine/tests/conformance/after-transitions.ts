import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  singleDelayMachine,
  raceEventMachine,
  multiDelayMachine,
  selfTargetMachine,
  namedDelayMachine,
} from "../fixtures/machines.js";
import { waitForState, waitForContext } from "../fixtures/helpers.js";
import type { BackendFixture } from "../fixtures/helpers.js";

export function afterConformance(backend: BackendFixture) {
  describe(`after transitions [${backend.name}]`, () => {
    const durableSingle = backend.createMachine(singleDelayMachine);
    const durableRace = backend.createMachine(raceEventMachine);
    const durableMulti = backend.createMachine(multiDelayMachine);
    const durableSelfTarget = backend.createMachine(selfTargetMachine);
    const durableNamed = backend.createMachine(namedDelayMachine);

    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());

    it("fires a single after delay and transitions to final state", async () => {
      const id = `after-single-${Date.now()}`;
      const handle = await durableSingle.start(id, {});

      const result = await handle.getResult();
      expect(result).toMatchObject({ timedOut: true });
    });

    it("event wins the race against a longer after delay", async () => {
      const id = `after-race-${Date.now()}`;
      const handle = await durableRace.start(id, {});

      await waitForState(handle, "waiting");
      await handle.send({ type: "RESPOND" });

      const result = await handle.getResult();
      expect(result).toMatchObject({ winner: "event" });
    });

    it("fires multiple after delays in sequence on the same state", async () => {
      const id = `after-multi-${Date.now()}`;
      const handle = await durableMulti.start(id, {});

      const result = await handle.getResult();
      expect(result).toMatchObject({ reminders: 1 });
    });

    it("first after fires then event arrives before second after", async () => {
      const id = `after-multi-event-${Date.now()}`;
      const handle = await durableMulti.start(id, {});

      await waitForContext(handle, (ctx) => ctx.reminders >= 1);
      await handle.send({ type: "RESPOND" });

      const result = await handle.getResult();
      expect(result).toMatchObject({ reminders: 1 });
    });

    it("self-targeting after with reenter ticks multiple times", async () => {
      const id = `after-self-${Date.now()}`;
      const handle = await durableSelfTarget.start(id, {});

      await waitForContext(handle, (ctx) => ctx.ticks >= 2, 15000);
      await handle.send({ type: "STOP" });

      const result = await handle.getResult();
      expect((result as any).ticks).toBeGreaterThanOrEqual(2);
    });

    it("self-targeting after preserves tick count in final context", async () => {
      const id = `after-self-exact-${Date.now()}`;
      const handle = await durableSelfTarget.start(id, {});

      await waitForContext(handle, (ctx) => ctx.ticks >= 3, 15000);
      await handle.send({ type: "STOP" });

      const result = await handle.getResult();
      expect((result as any).ticks).toBeGreaterThanOrEqual(3);
    });

    it("named delay resolves and fires correctly", async () => {
      const id = `after-named-${Date.now()}`;
      const handle = await durableNamed.start(id, {});

      const result = await handle.getResult();
      expect(result).toMatchObject({ expired: true });
    });

    it("named delay loses race to an event", async () => {
      const id = `after-named-race-${Date.now()}`;
      const handle = await durableNamed.start(id, {});

      await waitForState(handle, "waiting");
      await handle.send({ type: "RESPOND" });

      const result = await handle.getResult();
      expect(result).toMatchObject({ expired: false });
    });
  });
}
