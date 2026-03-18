import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  serializeMachineDefinition,
  computeStateDurations,
  detectActiveStep,
} from "@durable-machines/machine";
import type {
  DurableMachine,
  DurableStateSnapshot,
  TransitionRecord,
} from "@durable-machines/machine";
import type { MachineRegistry } from "../rest-types.js";
import { getAvailableEvents, getAvailableEventSchemas } from "../hateoas.js";
import { extractGraphData } from "./graph.js";
import type { GraphData } from "./graph.js";
import { buildActivityFeed } from "./activity-feed.js";
import {
  machineListPage,
  instanceListPage,
  startInstancePage,
} from "./html.js";
import { instanceDetailPage } from "./instance-detail.js";
import type { InstanceDetailData } from "./types.js";

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
  /** Maximum concurrent SSE connections. @defaultValue `100` */
  maxSseConnections?: number;
  /** Graph layout direction. @defaultValue `"RIGHT"` */
  graphDirection?: "RIGHT" | "DOWN";
}

/**
 * Creates a Hono sub-app with all dashboard routes.
 */
export function createDashboardRoutes(options: DashboardRouteOptions): Hono {
  const { machines, basePath, restBasePath, store, pollIntervalMs } = options;
  const maxSseConnections = options.maxSseConnections ?? 100;
  const graphDirection = options.graphDirection ?? "RIGHT";
  let sseConnections = 0;
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

  // ── GET /machines/:machineId/new — Start instance page ───────────────────

  app.get("/machines/:machineId/new", async (c) => {
    const machineId = c.req.param("machineId");
    const durable = machines.get(machineId);
    if (!durable) return c.notFound();

    const definition = serializeMachineDefinition(durable.machine);
    return c.html(startInstancePage(basePath, machineId, definition, restBasePath));
  });

  // ── GET /machines/:machineId — Instance list ────────────────────────────

  app.get("/machines/:machineId", async (c) => {
    const machineId = c.req.param("machineId");
    const durable = machines.get(machineId);
    if (!durable) return c.html(machineListPage(basePath, []), 404);

    const status = c.req.query("status");
    const instances = await durable.list(status ? { status } : undefined);
    return c.html(instanceListPage(basePath, machineId, instances, status));
  });

  // ── SSE routes ──────────────────────────────────────────────────────────────

  // ── SSE: /machines/:machineId/stream — Instance list updates ─────────────

  app.get("/machines/:machineId/stream", (c) => {
    const machineId = c.req.param("machineId");
    const durable = machines.get(machineId);
    if (!durable) return c.notFound();

    if (sseConnections >= maxSseConnections) {
      return c.json({ error: "Too many concurrent SSE connections" }, 429);
    }

    sseConnections++;
    return streamSSE(c, async (stream) => {
      try {
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
      } finally {
        sseConnections--;
      }
    });
  });

  // ── SSE: /machines/:machineId/instances/:instanceId/stream — Instance detail updates ──

  app.get("/machines/:machineId/instances/:instanceId/stream", (c) => {
    const machineId = c.req.param("machineId");
    const instanceId = c.req.param("instanceId");
    const durable = machines.get(machineId);
    if (!durable) return c.notFound();

    if (sseConnections >= maxSseConnections) {
      return c.json({ error: "Too many concurrent SSE connections" }, 429);
    }

    sseConnections++;
    return streamSSE(c, async (stream) => {
      try {
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
            const effects = await handle.listEffects();
            const eventLog = await handle.getEventLog({ limit: 50 });

            // Compute active sleep for SSE updates
            const sseActiveStates = resolveActiveStates(snapshot);
            const sseTransitions: TransitionRecord[] = await handle.getTransitions();
            const sseStateDurations = computeStateDurations(sseTransitions);
            const sseSleep = computeActiveSleep(sseGraphData, sseActiveStates, sseStateDurations);
            const sseVisitedStates = extractVisitedStates(sseTransitions);

            const sseActivityFeed = buildActivityFeed({
              transitions: sseTransitions,
              eventLog: eventLog ?? [],
              steps,
              effects,
              machineStates: sseDefinition.states,
            });

            // Fetch aggregate analytics if enabled
            const sseAnalytics = durable.getAnalytics?.();
            const [sseAggDurations, sseTransCounts] = sseAnalytics
              ? await Promise.all([
                  sseAnalytics.getAggregateStateDurations(),
                  sseAnalytics.getTransitionCounts(),
                ])
              : [undefined, undefined];

            const stateData = {
              snapshot,
              steps,
              availableEvents,
              eventSchemas,
              effects,
              activityFeed: sseActivityFeed,
              activeStep: detectActiveStep(steps),
              activeSleep: sseSleep,
              activeStates: sseActiveStates,
              visitedStates: sseVisitedStates,
              aggregateStateDurations: sseAggDurations,
              transitionCounts: sseTransCounts,
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
      } finally {
        sseConnections--;
      }
    });
  });

  // ── GET /machines/:machineId/instances/:instanceId — Instance detail ─────

  app.get("/machines/:machineId/instances/:instanceId", async (c) => {
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
      graphDirection,
    );

    return c.html(instanceDetailPage(basePath, restBasePath, data));
  });

  // ── POST /machines/:machineId/instances/:instanceId/send — Send event (form fallback) ──

  app.post("/machines/:machineId/instances/:instanceId/send", async (c) => {
    const machineId = c.req.param("machineId");
    const instanceId = c.req.param("instanceId");
    const durable = machines.get(machineId);
    if (!durable) return c.notFound();

    const body = await c.req.parseBody();
    const eventType = String(body["eventType"] || "");
    if (!eventType) return c.redirect(`${basePath}/machines/${machineId}/instances/${instanceId}`);

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
    return c.redirect(`${basePath}/machines/${machineId}/instances/${instanceId}`);
  });

  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function buildDetailData(
  durable: DurableMachine,
  machineId: string,
  instanceId: string,
  snapshot: DurableStateSnapshot,
  steps: import("@durable-machines/machine").StepInfo[],
  handle: import("@durable-machines/machine").DurableMachineHandle,
  graphDirection: "RIGHT" | "DOWN",
): Promise<InstanceDetailData> {
  const definition = serializeMachineDefinition(durable.machine);
  const graphData = extractGraphData(definition);
  const availableEvents = getAvailableEvents(durable.machine, snapshot);
  const eventSchemas = getAvailableEventSchemas(durable.machine, snapshot);

  const transitions: TransitionRecord[] = await handle.getTransitions();
  const stateDurations = computeStateDurations(transitions);

  const effects = await handle.listEffects();
  const eventLog = await handle.getEventLog({ limit: 50 });

  // Determine active/visited states from snapshot
  const activeStates = resolveActiveStates(snapshot);
  const visitedStates = extractVisitedStates(transitions);

  // Compute active sleep countdown if in a state with an `after` transition
  const activeSleep = computeActiveSleep(graphData, activeStates, stateDurations);

  const activityFeed = buildActivityFeed({
    transitions,
    eventLog: eventLog ?? [],
    steps,
    effects,
    machineStates: definition.states,
  });

  // Fetch aggregate analytics if enabled
  const analytics = durable.getAnalytics?.();
  const [aggregateStateDurations, transitionCounts] = analytics
    ? await Promise.all([
        analytics.getAggregateStateDurations(),
        analytics.getTransitionCounts(),
      ])
    : [undefined, undefined];

  return {
    machineId,
    instanceId,
    snapshot,
    steps,
    graphData,
    availableEvents,
    eventSchemas,
    effects,
    activityFeed,
    activeStates,
    visitedStates,
    activeSleep,
    aggregateStateDurations,
    transitionCounts,
    graphDirection,
  };
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
  stateDurations: import("@durable-machines/machine").StateDuration[],
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
