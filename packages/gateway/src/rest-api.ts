import { Hono } from "hono";
import { DurableMachineError } from "@durable-xstate/durable-machine";
import type { RestApiOptions } from "./rest-types.js";
import { toStateResponse } from "./hateoas.js";

/**
 * Creates a Hono app that exposes `DurableMachine` operations as a REST API
 * with HATEOAS responses.
 *
 * Routes (under `{basePath}/machines/:machineId/instances`):
 * - `POST   /`              — start a new instance
 * - `GET    /`              — list instances (optional `?status=` filter)
 * - `GET    /:instanceId`   — read current state
 * - `POST   /:instanceId/events` — send an event
 * - `GET    /:instanceId/result` — read final result
 * - `GET    /:instanceId/steps`  — list executed steps
 * - `GET    /:instanceId/effects` — list effect execution status
 * - `DELETE /:instanceId`   — cancel the instance
 *
 * @example
 * ```ts
 * const app = createRestApi({
 *   machines: new Map([["order", orderDurable]]),
 *   basePath: "/api/v1",
 * });
 * serve({ fetch: app.fetch, port: 3000 });
 * ```
 */
export function createRestApi(options: RestApiOptions): Hono {
  const { machines, basePath = "", shorthand = false } = options;
  const app = new Hono();

  // ── Global error handler ────────────────────────────────────────────────

  app.onError((err, c) => {
    if (err instanceof DurableMachineError) {
      const msg = err.message;
      const status = msg.includes("not found") ? 404
        : msg.includes("already exists") ? 409
        : msg.includes("not running") ? 409
        : msg.includes("cancelled") ? 410
        : 500;
      return c.json({ error: msg }, status);
    }

    return c.json({ error: "Internal server error" }, 500);
  });

  // ── Machine routes ──────────────────────────────────────────────────────

  const r = new Hono();

  // POST /machines/:machineId/instances — start a new instance
  r.post("/", async (c) => {
    const machineId = c.req.param("machineId")!;
    const durable = machines.get(machineId);
    if (!durable) return c.json({ error: "Machine not found" }, 404);

    const { instanceId, input } = await c.req.json<{ instanceId: string; input?: Record<string, unknown> }>();
    const handle = await durable.start(instanceId, input ?? {});
    const snapshot = await handle.getState();
    if (!snapshot) return c.json({ error: "Instance not found" }, 404);

    return c.json(toStateResponse(durable, basePath, machineId, instanceId, snapshot), 201);
  });

  // GET /machines/:machineId/instances — list instances
  r.get("/", async (c) => {
    const machineId = c.req.param("machineId")!;
    const durable = machines.get(machineId);
    if (!durable) return c.json({ error: "Machine not found" }, 404);

    const status = c.req.query("status");
    const list = await durable.list(status ? { status } : undefined);
    return c.json(list);
  });

  // GET /machines/:machineId/instances/:instanceId — read state
  r.get("/:instanceId", async (c) => {
    const machineId = c.req.param("machineId")!;
    const instanceId = c.req.param("instanceId")!;
    const durable = machines.get(machineId);
    if (!durable) return c.json({ error: "Machine not found" }, 404);

    const snapshot = await durable.get(instanceId).getState();
    if (!snapshot) return c.json({ error: "Instance not found" }, 404);

    return c.json(toStateResponse(durable, basePath, machineId, instanceId, snapshot));
  });

  // POST /machines/:machineId/instances/:instanceId/events — send event
  r.post("/:instanceId/events", async (c) => {
    const machineId = c.req.param("machineId")!;
    const instanceId = c.req.param("instanceId")!;
    const durable = machines.get(machineId);
    if (!durable) return c.json({ error: "Machine not found" }, 404);

    const event = await c.req.json();
    const handle = durable.get(instanceId);
    await handle.send(event);

    const snapshot = await handle.getState();
    if (!snapshot) return c.json({ error: "Instance not found" }, 404);

    return c.json(toStateResponse(durable, basePath, machineId, instanceId, snapshot));
  });

  // GET /machines/:machineId/instances/:instanceId/result — read result
  r.get("/:instanceId/result", async (c) => {
    const machineId = c.req.param("machineId")!;
    const instanceId = c.req.param("instanceId")!;
    const durable = machines.get(machineId);
    if (!durable) return c.json({ error: "Machine not found" }, 404);

    const snapshot = await durable.get(instanceId).getState();
    if (!snapshot) return c.json({ error: "Instance not found" }, 404);

    if (snapshot.status === "done") {
      return c.json({ result: snapshot.context });
    }
    if (snapshot.status === "error") {
      return c.json({ error: "Instance errored" }, 500);
    }

    return c.json({ status: "running" }, 202);
  });

  // GET /machines/:machineId/instances/:instanceId/steps — list steps
  r.get("/:instanceId/steps", async (c) => {
    const machineId = c.req.param("machineId")!;
    const instanceId = c.req.param("instanceId")!;
    const durable = machines.get(machineId);
    if (!durable) return c.json({ error: "Machine not found" }, 404);

    const steps = await durable.get(instanceId).getSteps();
    return c.json(steps);
  });

  // GET /machines/:machineId/instances/:instanceId/effects — list effects
  r.get("/:instanceId/effects", async (c) => {
    const machineId = c.req.param("machineId")!;
    const instanceId = c.req.param("instanceId")!;
    const durable = machines.get(machineId);
    if (!durable) return c.json({ error: "Machine not found" }, 404);

    const handle = durable.get(instanceId);
    if (!handle.listEffects) {
      return c.json({ error: "Effects not supported by this backend" }, 501);
    }

    const effects = await handle.listEffects();
    return c.json(effects);
  });

  // GET /machines/:machineId/instances/:instanceId/events/log — event log
  r.get("/:instanceId/events/log", async (c) => {
    const machineId = c.req.param("machineId")!;
    const instanceId = c.req.param("instanceId")!;
    const durable = machines.get(machineId);
    if (!durable) return c.json({ error: "Machine not found" }, 404);

    const handle = durable.get(instanceId);
    if (!handle.getEventLog) {
      return c.json({ error: "Event log not supported by this backend" }, 501);
    }

    const limit = c.req.query("limit");
    const after = c.req.query("after");
    const opts: { limit?: number; afterSeq?: number } = {};
    if (limit) opts.limit = Number(limit);
    if (after) opts.afterSeq = Number(after);

    const events = await handle.getEventLog(opts);
    return c.json(events);
  });

  // DELETE /machines/:machineId/instances/:instanceId — cancel
  r.delete("/:instanceId", async (c) => {
    const machineId = c.req.param("machineId")!;
    const instanceId = c.req.param("instanceId")!;
    const durable = machines.get(machineId);
    if (!durable) return c.json({ error: "Machine not found" }, 404);

    await durable.get(instanceId).cancel();
    return c.json({ cancelled: true });
  });

  const prefix = basePath ? `${basePath}/machines/:machineId/instances` : "/machines/:machineId/instances";
  app.route(prefix, r);

  // ── Shorthand routes ────────────────────────────────────────────────────

  if (shorthand) {
    if (machines.size !== 1) {
      throw new Error("Shorthand mode requires exactly one machine in the registry");
    }

    const [machineId, durable] = [...machines.entries()][0];
    const sp = basePath || "";

    // GET /:instanceId — read state
    app.get(`${sp}/:instanceId`, async (c) => {
      const instanceId = c.req.param("instanceId")!;
      const snapshot = await durable.get(instanceId).getState();
      if (!snapshot) return c.json({ error: "Not found" }, 404);
      return c.json(toStateResponse(durable, sp, machineId, instanceId, snapshot));
    });

    // POST /:instanceId/:event — send event
    app.post(`${sp}/:instanceId/:event`, async (c) => {
      const instanceId = c.req.param("instanceId")!;
      const event = c.req.param("event")!;
      const handle = durable.get(instanceId);
      await handle.send({ type: event });
      const snapshot = await handle.getState();
      if (!snapshot) return c.json({ error: "Not found" }, 404);
      return c.json(toStateResponse(durable, sp, machineId, instanceId, snapshot));
    });

    // POST /:instanceId — start instance
    app.post(`${sp}/:instanceId`, async (c) => {
      const instanceId = c.req.param("instanceId")!;
      const { input } = await c.req.json<{ input?: Record<string, unknown> }>();
      const handle = await durable.start(instanceId, input ?? {});
      const snapshot = await handle.getState();
      if (!snapshot) return c.json({ error: "Not found" }, 404);
      return c.json(toStateResponse(durable, sp, machineId, instanceId, snapshot), 201);
    });
  }

  return app;
}
