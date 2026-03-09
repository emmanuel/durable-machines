import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  serializeMachineDefinition,
  computeStateDurations,
  detectActiveStep,
} from "@durable-xstate/durable-machine";
import type {
  DurableMachine,
  DurableStateSnapshot,
  TransitionRecord,
} from "@durable-xstate/durable-machine";
import type { MachineRegistry } from "../rest-types.js";
import { getAvailableEvents, getAvailableEventSchemas } from "../hateoas.js";
import { extractGraphData } from "./graph.js";
import type { GraphData } from "./graph.js";
import {
  machineListPage,
  instanceListPage,
  startInstancePage,
  instanceDetailPage,
} from "./html.js";
import type { InstanceDetailData } from "./html.js";

export interface DashboardRouteOptions {
  machines: MachineRegistry;
  basePath: string;
  restBasePath: string;
  store?: {
    startListening(
      callback: (machineName: string, instanceId: string, topic: string) => void,
    ): Promise<void>;
    stopListening(): Promise<void>;
  };
  pollIntervalMs: number;
}

/**
 * Creates a Hono sub-app with all dashboard routes.
 */
export function createDashboardRoutes(options: DashboardRouteOptions): Hono {
  const { machines, basePath, restBasePath, store, pollIntervalMs } = options;
  const app = new Hono();

  // ── GET / — Machine list ─────────────────────────────────────────────────

  app.get("/", async (c) => {
    const items = await Promise.all(
      [...machines.entries()].map(async ([machineId, durable]) => {
        const instances = await durable.list();
        const definition = serializeMachineDefinition(durable.machine);
        return {
          machineId,
          instanceCount: instances.length,
          label: definition.label,
          description: definition.description,
          tags: definition.tags,
        };
      }),
    );
    return c.html(machineListPage(basePath, items));
  });

  // ── GET /:machineId/new — Start instance page ───────────────────────────

  app.get("/:machineId/new", async (c) => {
    const machineId = c.req.param("machineId");
    const durable = machines.get(machineId);
    if (!durable) return c.notFound();

    const definition = serializeMachineDefinition(durable.machine);
    return c.html(startInstancePage(basePath, machineId, definition, restBasePath));
  });

  // ── GET /:machineId — Instance list ──────────────────────────────────────

  app.get("/:machineId", async (c) => {
    const machineId = c.req.param("machineId");
    const durable = machines.get(machineId);
    if (!durable) return c.html(machineListPage(basePath, []), 404);

    const status = c.req.query("status");
    const instances = await durable.list(status ? { status } : undefined);
    return c.html(instanceListPage(basePath, machineId, instances, status));
  });

  // ── GET /:machineId/:instanceId — Instance detail ────────────────────────

  app.get("/:machineId/:instanceId", async (c) => {
    const machineId = c.req.param("machineId");
    const instanceId = c.req.param("instanceId");
    const durable = machines.get(machineId);
    if (!durable) return c.notFound();

    const handle = durable.get(instanceId);
    const [snapshot, steps] = await Promise.all([
      handle.getState(),
      handle.getSteps(),
    ]);
    if (!snapshot) return c.notFound();

    const data = await buildDetailData(
      durable,
      machineId,
      instanceId,
      snapshot,
      steps,
      handle,
    );

    return c.html(instanceDetailPage(basePath, restBasePath, data));
  });

  // ── POST /:machineId/:instanceId/send — Send event (form fallback) ──────

  app.post("/:machineId/:instanceId/send", async (c) => {
    const machineId = c.req.param("machineId");
    const instanceId = c.req.param("instanceId");
    const durable = machines.get(machineId);
    if (!durable) return c.notFound();

    const body = await c.req.parseBody();
    const eventType = String(body["eventType"] || "");
    if (!eventType) return c.redirect(`${basePath}/${machineId}/${instanceId}`);

    let payload: Record<string, unknown> = {};
    const raw = String(body["payload"] || "").trim();
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        // Ignore invalid JSON, send just the type
      }
    }

    await durable.get(instanceId).send({ type: eventType, ...payload });
    return c.redirect(`${basePath}/${machineId}/${instanceId}`);
  });

  // ── SSE: /sse/:machineId — Instance list updates ─────────────────────────

  app.get("/sse/:machineId", (c) => {
    const machineId = c.req.param("machineId");
    const durable = machines.get(machineId);
    if (!durable) return c.notFound();

    return streamSSE(c, async (stream) => {
      let lastJson = "";

      const sendUpdate = async () => {
        try {
          const instances = await durable.list();
          const json = JSON.stringify(instances);
          if (json !== lastJson) {
            lastJson = json;
            await stream.writeSSE({
              event: "instances",
              data: JSON.stringify({ instances }),
            });
          }
        } catch {
          // Instance may have been deleted, ignore
        }
      };

      // If store available, use LISTEN/NOTIFY for push
      if (store) {
        let notified = false;
        const listener = (machineName: string) => {
          if (machineName === machineId) notified = true;
        };

        await store.startListening(listener);
        try {
          await sendUpdate();
          while (!stream.aborted) {
            if (notified) {
              notified = false;
              await sendUpdate();
            }
            await sleep(200);
          }
        } finally {
          await store.stopListening();
        }
      } else {
        // Poll fallback
        while (!stream.aborted) {
          await sendUpdate();
          await sleep(pollIntervalMs);
        }
      }
    });
  });

  // ── SSE: /sse/:machineId/:instanceId — Instance detail updates ──────────

  app.get("/sse/:machineId/:instanceId", (c) => {
    const machineId = c.req.param("machineId");
    const instanceId = c.req.param("instanceId");
    const durable = machines.get(machineId);
    if (!durable) return c.notFound();

    return streamSSE(c, async (stream) => {
      const handle = durable.get(instanceId);
      // Static graph data — computed once, reused across SSE ticks
      const sseDefinition = serializeMachineDefinition(durable.machine);
      const sseGraphData = extractGraphData(sseDefinition);
      let lastJson = "";

      const sendUpdate = async (): Promise<boolean> => {
        try {
          const [snapshot, steps] = await Promise.all([
            handle.getState(),
            handle.getSteps(),
          ]);
          if (!snapshot) return false;

          const availableEvents = getAvailableEvents(durable.machine, snapshot);
          const eventSchemas = getAvailableEventSchemas(durable.machine, snapshot);
          const effects = handle.listEffects ? await handle.listEffects() : undefined;
          const eventLog = handle.getEventLog ? await handle.getEventLog({ limit: 50 }) : undefined;

          // Compute active sleep for SSE updates
          const sseActiveStates = resolveActiveStates(snapshot);
          const sseTransitions: TransitionRecord[] = handle.getTransitions
            ? await handle.getTransitions()
            : buildTransitionsFromSteps(steps, snapshot);
          const sseStateDurations = computeStateDurations(sseTransitions);
          const sseSleep = computeActiveSleep(sseGraphData, sseActiveStates, sseStateDurations);

          const stateData = {
            snapshot,
            steps,
            availableEvents,
            eventSchemas,
            effects,
            eventLog,
            activeStep: detectActiveStep(steps),
            activeSleep: sseSleep,
          };

          const json = JSON.stringify(stateData);
          if (json !== lastJson) {
            lastJson = json;
            await stream.writeSSE({
              event: "state",
              data: json,
            });
          }

          if (snapshot.status !== "running") {
            await stream.writeSSE({
              event: "complete",
              data: JSON.stringify({ status: snapshot.status }),
            });
            return true; // Signal stream end
          }
        } catch {
          // Ignore errors, retry on next tick
        }
        return false;
      };

      if (store) {
        let notified = false;
        const listener = (_machineName: string, instId: string) => {
          if (instId === instanceId) notified = true;
        };

        await store.startListening(listener);
        try {
          const done = await sendUpdate();
          if (done) return;
          while (!stream.aborted) {
            if (notified) {
              notified = false;
              const done = await sendUpdate();
              if (done) return;
            }
            await sleep(200);
          }
        } finally {
          await store.stopListening();
        }
      } else {
        // Poll fallback
        while (!stream.aborted) {
          const done = await sendUpdate();
          if (done) return;
          await sleep(pollIntervalMs);
        }
      }
    });
  });

  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function buildDetailData(
  durable: DurableMachine,
  machineId: string,
  instanceId: string,
  snapshot: DurableStateSnapshot,
  steps: import("@durable-xstate/durable-machine").StepInfo[],
  handle: import("@durable-xstate/durable-machine").DurableMachineHandle,
): Promise<InstanceDetailData> {
  const definition = serializeMachineDefinition(durable.machine);
  const graphData = extractGraphData(definition);
  const availableEvents = getAvailableEvents(durable.machine, snapshot);
  const eventSchemas = getAvailableEventSchemas(durable.machine, snapshot);

  // Use real transitions if available, otherwise fall back to a single-entry stub
  const transitions: TransitionRecord[] = handle.getTransitions
    ? await handle.getTransitions()
    : buildTransitionsFromSteps(steps, snapshot);
  const stateDurations = computeStateDurations(transitions);

  const effects = handle.listEffects ? await handle.listEffects() : undefined;
  const eventLog = handle.getEventLog ? await handle.getEventLog({ limit: 50 }) : undefined;

  // Determine active/visited states from snapshot
  const activeStates = resolveActiveStates(snapshot);
  const visitedStates = extractVisitedStates(transitions);

  // Compute active sleep countdown if in a state with an `after` transition
  const activeSleep = computeActiveSleep(graphData, activeStates, stateDurations);

  return {
    machineId,
    instanceId,
    snapshot,
    steps,
    graphData,
    transitions,
    stateDurations,
    availableEvents,
    eventSchemas,
    effects,
    eventLog,
    activeStates,
    visitedStates,
    activeSleep,
  };
}

/**
 * Build transition records from step timing info.
 * This is a best-effort reconstruction for non-PG backends.
 */
function buildTransitionsFromSteps(
  steps: import("@durable-xstate/durable-machine").StepInfo[],
  snapshot: DurableStateSnapshot,
): TransitionRecord[] {
  // Without PG store's getTransitions(), we have limited data.
  // At minimum, show the current state as a single "transition".
  const now = Date.now();
  const firstStepTs = steps.length > 0 && steps[0].startedAtEpochMs
    ? steps[0].startedAtEpochMs
    : now;

  return [{
    from: null,
    to: snapshot.value,
    ts: firstStepTs,
  }];
}

/**
 * Resolve the set of currently active state paths from a snapshot.
 */
function resolveActiveStates(snapshot: DurableStateSnapshot): string[] {
  const result: string[] = [];
  collectStatePaths(snapshot.value, "", result);
  return result;
}

function collectStatePaths(
  value: unknown,
  prefix: string,
  result: string[],
): void {
  if (typeof value === "string") {
    result.push(prefix ? `${prefix}.${value}` : value);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      result.push(path);
      collectStatePaths(child, path, result);
    }
  }
}

/**
 * Extract the set of visited state paths from transition records.
 */
function extractVisitedStates(transitions: TransitionRecord[]): string[] {
  const visited = new Set<string>();
  for (const t of transitions) {
    const paths: string[] = [];
    collectStatePaths(t.to, "", paths);
    for (const p of paths) visited.add(p);
  }
  return [...visited];
}

/**
 * Compute active sleep info: if the machine is in a state with an `after` transition,
 * return the state, delay, and computed wake time.
 */
export function computeActiveSleep(
  graphData: GraphData,
  activeStates: string[],
  stateDurations: import("@durable-xstate/durable-machine").StateDuration[],
): ActiveSleep | null {
  // Find after-edges whose source is an active state
  for (const edge of graphData.edges) {
    if (edge.type === "after" && edge.delay != null && activeStates.includes(edge.source)) {
      // Find the enteredAt for this active state
      const dur = stateDurations.find(
        (d) => d.exitedAt === null && statePathMatches(d.state, edge.source),
      );
      if (dur) {
        return {
          stateId: edge.source,
          delay: edge.delay,
          enteredAt: dur.enteredAt,
          wakeAt: dur.enteredAt + edge.delay,
        };
      }
    }
  }
  return null;
}

export interface ActiveSleep {
  stateId: string;
  delay: number;
  enteredAt: number;
  wakeAt: number;
}

/** Check if a state value matches a dot-path (handles both string and nested object values). */
function statePathMatches(stateValue: unknown, path: string): boolean {
  if (typeof stateValue === "string") return stateValue === path;
  if (typeof stateValue === "object" && stateValue !== null) {
    const resolved: string[] = [];
    collectStatePaths(stateValue, "", resolved);
    return resolved.includes(path);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
