import type { AnyStateMachine } from "xstate";
import { walkStateNodes } from "./validate.js";
import { getPromptConfig } from "./prompt.js";
import { getEffectsConfig } from "./effects.js";
import type {
  SerializedMachine,
  SerializedStateNode,
  TransitionRecord,
  StateDuration,
  StepInfo,
} from "./types.js";

const META_KEY = "xstate-durable";

/**
 * Serializes a machine definition into a flat, JSON-serializable graph
 * suitable for UI rendering or inspection.
 *
 * @param machine - The XState machine definition to serialize
 * @returns A {@link SerializedMachine} containing all state nodes, transitions, and metadata
 */
export function serializeMachineDefinition(
  machine: AnyStateMachine,
): SerializedMachine {
  const states: Record<string, SerializedStateNode> = {};

  for (const [path, stateNode] of walkStateNodes(machine.root)) {
    const node: SerializedStateNode = {
      path,
      type: stateNode.type,
    };

    // Durable marker
    const meta: Record<string, any> | undefined = stateNode.meta;
    if (meta?.[META_KEY]?.durable === true) {
      node.durable = true;
    }

    // Prompt config
    const promptConfig = getPromptConfig(meta);
    if (promptConfig) {
      node.prompt = promptConfig;
    }

    // Effects config
    const effectConfigs = getEffectsConfig(meta);
    if (effectConfigs) {
      node.effects = effectConfigs;
    }

    // Invoke definitions
    const invokeList: any[] = stateNode.invoke ?? [];
    if (invokeList.length > 0) {
      node.invoke = invokeList.map((inv: any) => ({
        id: inv.id,
        src:
          typeof inv.src === "string"
            ? inv.src
            : inv.src?.config?.id ?? inv.id,
      }));
    }

    // After transitions
    const afterDefs: any[] = stateNode.after ?? [];
    if (afterDefs.length > 0) {
      node.after = afterDefs.map((def: any) => {
        const entry: {
          delay: number | string;
          target?: string;
          reenter?: boolean;
          guard?: string;
        } = { delay: def.delay };
        if (def.target?.length > 0) {
          entry.target = stateNodePath(def.target[0]);
        }
        if (def.reenter === true) {
          entry.reenter = true;
        }
        if (def.guard) {
          entry.guard = guardName(def.guard);
        }
        return entry;
      });
    }

    // Always transitions
    const alwaysList: any[] = stateNode.always ?? [];
    if (alwaysList.length > 0) {
      node.always = alwaysList.map((def: any) => {
        const entry: { target?: string; guard?: string } = {};
        if (def.target?.length > 0) {
          entry.target = stateNodePath(def.target[0]);
        }
        if (def.guard) {
          entry.guard = guardName(def.guard);
        }
        return entry;
      });
    }

    // On event handlers
    const onHandlers = stateNode.on;
    if (typeof onHandlers === "object" && onHandlers !== null) {
      const on: Record<string, { target?: string; guard?: string }[]> = {};
      for (const [eventType, transitions] of Object.entries(onHandlers)) {
        const transArray = Array.isArray(transitions)
          ? transitions
          : [transitions];
        on[eventType] = transArray.map((def: any) => {
          const entry: { target?: string; guard?: string } = {};
          if (def.target?.length > 0) {
            entry.target = stateNodePath(def.target[0]);
          }
          if (def.guard) {
            entry.guard = guardName(def.guard);
          }
          return entry;
        });
      }
      if (Object.keys(on).length > 0) {
        node.on = on;
      }
    }

    // Children (compound/parallel)
    const childStates = stateNode.states ?? {};
    const childKeys = Object.keys(childStates);
    if (childKeys.length > 0) {
      node.children = childKeys.map((key) =>
        path ? `${path}.${key}` : key,
      );
    }

    states[path] = node;
  }

  // Determine initial state
  const rootStates = machine.root.states ?? {};
  const initialKey =
    (machine.root as any).initial?.target?.[0]?.key ??
    Object.keys(rootStates)[0] ??
    "";

  // Extract schemas and metadata from machine.schemas (set by durableSetup())
  const durableSchemas = (machine as any).schemas?.[META_KEY] as
    | {
        events?: Record<string, import("./types.js").FormField[]>;
        input?: import("./types.js").FormField[];
        label?: string;
        description?: string;
        tags?: string[];
      }
    | undefined;

  const result: SerializedMachine = {
    id: machine.id,
    initial: initialKey,
    states,
  };

  if (durableSchemas?.events && Object.keys(durableSchemas.events).length > 0) {
    result.eventSchemas = durableSchemas.events;
  }
  if (durableSchemas?.input && durableSchemas.input.length > 0) {
    result.inputSchema = durableSchemas.input;
  }
  if (durableSchemas?.label) result.label = durableSchemas.label;
  if (durableSchemas?.description) result.description = durableSchemas.description;
  if (durableSchemas?.tags && durableSchemas.tags.length > 0) result.tags = durableSchemas.tags;

  return result;
}

/**
 * Computes how long the machine spent in each state based on transition records.
 *
 * @param transitions - Ordered array of {@link TransitionRecord} entries
 * @returns Array of {@link StateDuration} objects with timing for each state visit
 */
export function computeStateDurations(
  transitions: TransitionRecord[],
): StateDuration[] {
  if (transitions.length === 0) return [];

  const durations: StateDuration[] = [];

  for (let i = 0; i < transitions.length; i++) {
    const enteredAt = transitions[i].ts;
    const exitedAt =
      i + 1 < transitions.length ? transitions[i + 1].ts : null;
    const durationMs =
      exitedAt !== null ? exitedAt - enteredAt : Date.now() - enteredAt;

    durations.push({
      state: transitions[i].to,
      enteredAt,
      exitedAt,
      durationMs,
    });
  }

  return durations;
}

/**
 * Finds the currently executing (incomplete) step, if any.
 *
 * @param steps - Array of {@link StepInfo} from the workflow's step history
 * @returns The in-progress {@link StepInfo}, or `null` if all steps are complete
 */
export function detectActiveStep(steps: StepInfo[]): StepInfo | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (
      steps[i].startedAtEpochMs !== undefined &&
      steps[i].completedAtEpochMs === undefined
    ) {
      return steps[i];
    }
  }
  return null;
}

// ─── Internal Helpers ──────────────────────────────────────────────────────

/** Extracts the dot-path from an XState state node reference. */
function stateNodePath(stateNode: any): string {
  if (typeof stateNode === "string") return stateNode;
  // XState v5 state node objects have a `.path` array
  const path: string[] = stateNode.path ?? [];
  return path.join(".");
}

/** Extracts a guard name from a guard definition. */
function guardName(guard: any): string {
  if (typeof guard === "string") return guard;
  return guard?.type ?? guard?.name ?? "unknown";
}
