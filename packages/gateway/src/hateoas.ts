import type { DurableMachine, DurableStateSnapshot } from "@durable-xstate/durable-machine";
import type { HateoasLinks, StateResponse } from "./rest-types.js";

/**
 * Compute available event types for the current state by resolving the
 * snapshot and inspecting active state nodes' `on` handlers.
 *
 * Uses the machine from `DurableMachine.machine` — typed loosely to avoid
 * a direct `xstate` dependency in this package.
 *
 * Returns only user-facing events (filters out internal `xstate.*` events).
 */
export function getAvailableEvents(
  machine: DurableMachine["machine"],
  snapshot: DurableStateSnapshot,
): string[] {
  const resolved = (machine as any).resolveState({
    value: snapshot.value,
    context: snapshot.context,
  });

  const events = new Set<string>();
  for (const node of (resolved as any)._nodes) {
    const onHandlers = (node as any).on;
    if (typeof onHandlers === "object" && onHandlers !== null) {
      for (const eventType of Object.keys(onHandlers)) {
        if (!eventType.startsWith("xstate.")) {
          events.add(eventType);
        }
      }
    }
  }

  return [...events].sort();
}

/**
 * Build HATEOAS links for a machine instance.
 */
export function buildLinks(
  basePath: string,
  machineId: string,
  instanceId: string,
  availableEvents: string[],
): HateoasLinks {
  const base = `${basePath}/machines/${machineId}/instances/${instanceId}`;
  return {
    self: base,
    send: `${base}/events`,
    events: availableEvents,
    result: `${base}/result`,
    steps: `${base}/steps`,
    cancel: base,
    effects: `${base}/effects`,
  };
}

/**
 * Build a full {@link StateResponse} with HATEOAS links.
 */
export function toStateResponse(
  durable: DurableMachine,
  basePath: string,
  machineId: string,
  instanceId: string,
  snapshot: DurableStateSnapshot,
): StateResponse {
  const availableEvents = getAvailableEvents(durable.machine, snapshot);
  return {
    instanceId,
    state: snapshot.value,
    context: snapshot.context,
    status: snapshot.status,
    links: buildLinks(basePath, machineId, instanceId, availableEvents),
  };
}
