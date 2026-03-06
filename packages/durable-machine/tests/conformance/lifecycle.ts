import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { orderMachine } from "../fixtures/machines.js";
import { waitForState } from "../fixtures/helpers.js";
import type { BackendFixture } from "../fixtures/helpers.js";

export function lifecycleConformance(backend: BackendFixture) {
  describe(`lifecycle [${backend.name}]`, () => {
    const durable = backend.createMachine(orderMachine);

    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());

    it("starts a machine and reaches initial durable state", async () => {
      const id = `lifecycle-init-${Date.now()}`;
      const handle = await durable.start(id, { orderId: "o1", total: 50 });

      await waitForState(handle, "pending");
      const state = await handle.getState();
      expect(state).not.toBeNull();
      expect(state!.value).toBe("pending");
      expect(state!.status).toBe("running");
      expect(state!.context).toMatchObject({ orderId: "o1", total: 50 });
    });

    it("sends an event and transitions through invoke to next durable state", async () => {
      const id = `lifecycle-pay-${Date.now()}`;
      const handle = await durable.start(id, { orderId: "o2", total: 99.99 });

      await waitForState(handle, "pending");
      await handle.send({ type: "PAY" });
      await waitForState(handle, "paid");

      const state = await handle.getState();
      expect(state!.value).toBe("paid");
      expect(state!.context).toMatchObject({
        orderId: "o2",
        total: 99.99,
        chargeId: "ch_99.99",
      });
    });

    it("completes full lifecycle: pending → pay → paid → ship → delivered", async () => {
      const id = `lifecycle-full-${Date.now()}`;
      const handle = await durable.start(id, { orderId: "o3", total: 25 });

      await waitForState(handle, "pending");
      await handle.send({ type: "PAY" });
      await waitForState(handle, "paid");
      await handle.send({ type: "SHIP" });

      const result = await handle.getResult();
      expect(result).toMatchObject({
        orderId: "o3",
        total: 25,
        chargeId: "ch_25",
        trackingNumber: "tr_o3",
      });
    });

    it("can cancel from initial state", async () => {
      const id = `lifecycle-cancel-${Date.now()}`;
      const handle = await durable.start(id, { orderId: "o4", total: 10 });

      await waitForState(handle, "pending");
      await handle.send({ type: "CANCEL" });

      const result = await handle.getResult();
      expect(result).toMatchObject({ orderId: "o4", total: 10 });
    });

    it("retrieves an existing machine handle via get()", async () => {
      const id = `lifecycle-get-${Date.now()}`;
      await durable.start(id, { orderId: "o5", total: 30 });

      const handle = durable.get(id);
      await waitForState(handle, "pending");
      const state = await handle.getState();
      expect(state!.value).toBe("pending");
    });

    it("returns step history via getSteps()", async () => {
      const id = `lifecycle-steps-${Date.now()}`;
      const handle = await durable.start(id, { orderId: "o6", total: 42 });

      await waitForState(handle, "pending");
      await handle.send({ type: "PAY" });
      await waitForState(handle, "paid");

      const steps = await handle.getSteps();
      expect(steps.length).toBeGreaterThan(0);

      const invokeStep = steps.find((s) => s.name === "invoke:processPayment");
      expect(invokeStep).toBeDefined();
      expect(invokeStep!.output).toMatchObject({ chargeId: "ch_42" });
    });
  });
}
