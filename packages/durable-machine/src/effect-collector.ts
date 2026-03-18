import type { AnyStateMachine, AnyMachineSnapshot, AnyEventObject } from "xstate";
import { getCompiledEffects } from "./effects.js";
import type { ResolvedEffect } from "./effects.js";

/**
 * Executable action object shape returned by XState's `transition()`.
 * We only need the fields relevant to emit actions.
 */
export interface ExecutableAction {
  type: string;
  params?: Record<string, unknown>;
}

/**
 * Extracts emitted effects from the actions array returned by `transition()`.
 *
 * XState emit actions have `type: "xstate.emit"` and carry the emitted event
 * in `params.event`. The event object maps directly to a {@link ResolvedEffect}
 * (it must have a `type` string property at minimum).
 *
 * @param actions - The executable actions array from `transition()`
 * @returns Resolved effects extracted from emit actions
 */
export function extractEmittedEffects(
  actions: readonly ExecutableAction[],
): ResolvedEffect[] {
  const effects: ResolvedEffect[] = [];
  for (const action of actions) {
    if (action.type !== "xstate.emit") continue;
    const params = action.params;
    if (!params || !("event" in params)) continue;
    const event = params.event;
    if (
      event != null &&
      typeof event === "object" &&
      "type" in event &&
      typeof (event as any).type === "string"
    ) {
      effects.push(event as ResolvedEffect);
    }
  }
  return effects;
}

/**
 * Collects and resolves effects from states entered during a transition.
 *
 * Compares `prevSnapshot._nodes` and `nextSnapshot._nodes` to determine
 * which state nodes were newly entered, then reads their effect configs
 * and resolves any `{{ template }}` expressions against the next snapshot's
 * context and the triggering event.
 *
 * @param _machine - The XState machine definition (reserved for future use)
 * @param prevSnapshot - The snapshot before the transition
 * @param nextSnapshot - The snapshot after the transition
 * @param event - The event that triggered the transition
 * @returns An object containing the resolved effects array
 */
export function collectAndResolveEffects(
  _machine: AnyStateMachine,
  prevSnapshot: AnyMachineSnapshot,
  nextSnapshot: AnyMachineSnapshot,
  event: AnyEventObject,
): { effects: ResolvedEffect[] } {
  // Build set of previous node ids
  const prevNodeIds = new Set(
    (prevSnapshot._nodes as any[]).map((node: any) => node.id),
  );

  // Find newly entered nodes
  const enteredNodes = (nextSnapshot._nodes as any[]).filter(
    (node: any) => !prevNodeIds.has(node.id),
  );

  const effects: ResolvedEffect[] = [];

  for (const node of enteredNodes) {
    const compiledEffects = getCompiledEffects(node.meta);
    if (!compiledEffects) continue;

    const context = (nextSnapshot as any).context ?? {};

    for (const resolveEffect of compiledEffects) {
      const resolved = resolveEffect({ context, event }) as ResolvedEffect;
      effects.push(resolved);
    }
  }

  return { effects };
}
