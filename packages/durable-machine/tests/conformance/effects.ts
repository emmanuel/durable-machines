/**
 * Conformance tests for the transactional outbox effects system.
 * Verifies that effects declared via durableState({ effects: [...] })
 * are collected and executed correctly across backends.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { BackendFixture } from "../fixtures/helpers.js";
import { waitForState } from "../fixtures/helpers.js";
import { effectsMachine, orderMachine } from "../fixtures/machines.js";
import { createEffectHandlers } from "../../src/effects.js";
import type { ResolvedEffect } from "../../src/effects.js";

export function effectsConformance(backend: BackendFixture) {
  describe(`effects [${backend.name}]`, () => {
    const calls: ResolvedEffect[] = [];
    const handlers = createEffectHandlers({
      webhook: async (effect) => { calls.push(effect); },
      analytics: async (effect) => { calls.push(effect); },
    });

    const dm = backend.createMachine(effectsMachine, { effectHandlers: handlers });

    // Machine without effectHandlers — should work unchanged
    const dmNoEffects = backend.createMachine(orderMachine);

    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());
    beforeEach(() => { calls.length = 0; });

    it("fires effects on initial state entry", async () => {
      const id = `fx-init-${Date.now()}`;
      const handle = await dm.start(id, { orderId: "ord-1" });

      // Wait for effects to be processed by the poller
      await waitForEffects(calls, 2, 5000);

      expect(calls.length).toBe(2);
      const types = calls.map((c) => c.type).sort();
      expect(types).toEqual(["analytics", "webhook"]);

      // Verify initial state is correct
      const state = await handle.getState();
      expect(state?.value).toBe("pending");
    });

    it("resolves template expressions in effect payloads", async () => {
      const id = `fx-tmpl-${Date.now()}`;
      await dm.start(id, { orderId: "ord-tmpl-42" });

      await waitForEffects(calls, 2, 5000);

      const analyticEffect = calls.find((c) => c.type === "analytics");
      expect(analyticEffect).toBeDefined();
      expect(analyticEffect!.orderId).toBe("ord-tmpl-42");
    });

    it("fires effects on event-triggered state change", async () => {
      const id = `fx-event-${Date.now()}`;
      const handle = await dm.start(id, { orderId: "ord-2" });

      // Wait for initial effects
      await waitForEffects(calls, 2, 5000);
      calls.length = 0;

      // PROCESS triggers invoke → completed state (which has effects)
      await handle.send({ type: "PROCESS" });
      await waitForState(handle, "completed", 5000);

      // Wait for completed state effects
      await waitForEffects(calls, 1, 5000);

      expect(calls.length).toBe(1);
      expect(calls[0].type).toBe("webhook");
      expect(calls[0].url).toBe("https://example.com/completed");
    });

    it("does not fire effects when state doesn't change", async () => {
      const id = `fx-nochange-${Date.now()}`;
      const handle = await dm.start(id, { orderId: "ord-3" });

      // Wait for initial effects
      await waitForEffects(calls, 2, 5000);
      calls.length = 0;

      // Send an event that doesn't cause a transition (no handler for DONE in pending)
      await handle.send({ type: "DONE" });

      // Wait a bit to ensure no spurious effects
      await new Promise((r) => setTimeout(r, 1500));
      expect(calls.length).toBe(0);
    });

    it("machines without effectHandlers work unchanged", async () => {
      const id = `fx-none-${Date.now()}`;
      const handle = await dmNoEffects.start(id, { orderId: "ord-4", total: 100 });

      const state = await handle.getState();
      expect(state?.value).toBe("pending");
      expect(state?.status).toBe("running");
    });
  });
}

async function waitForEffects(
  calls: ResolvedEffect[],
  expectedCount: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (calls.length >= expectedCount) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out waiting for ${expectedCount} effects (got ${calls.length})`,
  );
}
