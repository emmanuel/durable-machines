import type { AnyStateMachine, AnyMachineSnapshot, AnyEventObject } from "xstate";
import { getEffectsConfig } from "./effects.js";
import type { ResolvedEffect } from "./effects.js";
import { resolveExpressions } from "./definition/expressions.js";

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
    const configs = getEffectsConfig(node.meta);
    if (!configs) continue;

    const scope = {
      context: (nextSnapshot as any).context ?? {},
      event,
    };

    for (const config of configs) {
      const resolved = resolveExpressions(config, scope) as ResolvedEffect;
      effects.push(resolved);
    }
  }

  return { effects };
}
