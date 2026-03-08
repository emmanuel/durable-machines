import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { orderMachine } from "../fixtures/machines.js";
import { waitForState } from "../fixtures/helpers.js";
import type { BackendFixture } from "../fixtures/helpers.js";

export function eventLogConformance(backend: BackendFixture) {
  describe(`event-log [${backend.name}]`, () => {
    const durable = backend.createMachine(orderMachine, { enableTransitionStream: true });

    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());

    it("records events in the log", async () => {
      const id = `evlog-record-${Date.now()}`;
      const handle = await durable.start(id, { orderId: "o1", total: 50 });
      await waitForState(handle, "pending");

      await handle.send({ type: "PAY" });
      await waitForState(handle, "paid");

      const log = await handle.getEventLog!();
      expect(log.length).toBeGreaterThanOrEqual(1);

      const payEvent = log.find((e) => (e.payload as any).type === "PAY");
      expect(payEvent).toBeDefined();
      expect(payEvent!.topic).toBe("event");
      expect(payEvent!.source).toBeNull();
    });

    it("getEventLog returns all events in order", async () => {
      const id = `evlog-order-${Date.now()}`;
      const handle = await durable.start(id, { orderId: "o2", total: 99 });
      await waitForState(handle, "pending");

      await handle.send({ type: "PAY" });
      await waitForState(handle, "paid");
      await handle.send({ type: "SHIP" });
      await handle.getResult();

      const log = await handle.getEventLog!();
      expect(log.length).toBeGreaterThanOrEqual(2);

      // Verify ordering by seq
      for (let i = 1; i < log.length; i++) {
        expect(log[i].seq).toBeGreaterThan(log[i - 1].seq);
      }
    });

    it("getEventLog supports limit parameter", async () => {
      const id = `evlog-limit-${Date.now()}`;
      const handle = await durable.start(id, { orderId: "o3", total: 25 });
      await waitForState(handle, "pending");

      await handle.send({ type: "PAY" });
      await waitForState(handle, "paid");
      await handle.send({ type: "SHIP" });
      await handle.getResult();

      const all = await handle.getEventLog!();
      expect(all.length).toBeGreaterThanOrEqual(2);

      const limited = await handle.getEventLog!({ limit: 1 });
      expect(limited.length).toBe(1);
      expect(limited[0].seq).toBe(all[0].seq);
    });

    it("getEventLog supports afterSeq parameter", async () => {
      const id = `evlog-after-${Date.now()}`;
      const handle = await durable.start(id, { orderId: "o4", total: 10 });
      await waitForState(handle, "pending");

      await handle.send({ type: "PAY" });
      await waitForState(handle, "paid");
      await handle.send({ type: "SHIP" });
      await handle.getResult();

      const all = await handle.getEventLog!();
      expect(all.length).toBeGreaterThanOrEqual(2);

      const afterFirst = await handle.getEventLog!({ afterSeq: all[0].seq });
      expect(afterFirst.length).toBe(all.length - 1);
      expect(afterFirst[0].seq).toBe(all[1].seq);
    });

    it("events that don't cause state change are still logged", async () => {
      const id = `evlog-ignored-${Date.now()}`;
      const handle = await durable.start(id, { orderId: "o5", total: 30 });
      await waitForState(handle, "pending");

      // SHIP is not handled in "pending" state — should be ignored but logged
      await handle.send({ type: "SHIP" });
      // Small delay for event to be processed
      await new Promise((r) => setTimeout(r, 200));

      const state = await handle.getState();
      expect(state!.value).toBe("pending"); // State unchanged

      const log = await handle.getEventLog!();
      const shipEvent = log.find((e) => (e.payload as any).type === "SHIP");
      expect(shipEvent).toBeDefined();
    });

    it("each event has correct createdAt timestamp", async () => {
      const before = Date.now();
      const id = `evlog-ts-${Date.now()}`;
      const handle = await durable.start(id, { orderId: "o6", total: 42 });
      await waitForState(handle, "pending");

      await handle.send({ type: "PAY" });
      await waitForState(handle, "paid");
      const after = Date.now();

      const log = await handle.getEventLog!();
      for (const entry of log) {
        expect(entry.createdAt).toBeGreaterThanOrEqual(before);
        expect(entry.createdAt).toBeLessThanOrEqual(after);
      }
    });
  });
}
