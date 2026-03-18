import type { DurableMachine, DurableStateSnapshot, FormField } from "@durable-machines/machine";
import type { HateoasLinks, StateResponse, InstanceRef } from "./rest-types.js";

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
 * Returns the event field schemas for events available in the current state.
 * Only includes events that have declared schemas via `durableSetup()`.
 */
export function getAvailableEventSchemas(
  machine: DurableMachine["machine"],
  snapshot: DurableStateSnapshot,
): Record<string, FormField[]> {
  const allSchemas = (machine as any).schemas?.["xstate-durable"]?.events as
    | Record<string, FormField[]>
    | undefined;
  if (!allSchemas) return {};

  const available = getAvailableEvents(machine, snapshot);
  const result: Record<string, FormField[]> = {};
  for (const eventType of available) {
    if (allSchemas[eventType]) {
      result[eventType] = allSchemas[eventType];
    }
  }
  return result;
}

/**
 * Build HATEOAS links for a machine instance.
 */
export function buildLinks(
  ref: InstanceRef,
  availableEvents: string[],
): HateoasLinks {
  const base = `${ref.basePath}/machines/${ref.machineId}/instances/${ref.instanceId}`;
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
  ref: InstanceRef,
  snapshot: DurableStateSnapshot,
): StateResponse {
  const availableEvents = getAvailableEvents(durable.machine, snapshot);
  return {
    instanceId: ref.instanceId,
    state: snapshot.value,
    context: snapshot.context,
    status: snapshot.status,
    links: buildLinks(ref, availableEvents),
  };
}
