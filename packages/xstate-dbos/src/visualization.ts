import { DBOS } from "@dbos-inc/dbos-sdk";
import type { AnyStateMachine } from "xstate";
import { walkStateNodes } from "./validate.js";
import { getPromptConfig } from "./prompt.js";
import type {
  SerializedMachine,
  SerializedStateNode,
  TransitionRecord,
  StateDuration,
  MachineVisualizationState,
  DurableStateSnapshot,
  StepInfo,
} from "./types.js";

const META_KEY = "xstate-dbos";

/**
 * Serializes a machine definition into a flat, JSON-serializable graph
 * suitable for UI rendering or inspection.
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

    // Quiescent marker
    const meta: Record<string, any> | undefined = stateNode.meta;
    if (meta?.[META_KEY]?.quiescent === true) {
      node.quiescent = true;
    }

    // Prompt config
    const promptConfig = getPromptConfig(meta);
    if (promptConfig) {
      node.prompt = promptConfig;
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

  return {
    id: machine.id,
    initial: initialKey,
    states,
  };
}

/**
 * Computes how long the machine spent in each state based on transition records.
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

/**
 * Combines static machine definition with runtime data for a complete
 * visualization snapshot.
 *
 * Transition history is stored via `setEvent("xstate.transitions", ...)` as
 * an accumulating array (not `writeStream`) so reads are always non-blocking,
 * even for in-progress workflows.
 */
export async function getVisualizationState(
  machine: AnyStateMachine,
  workflowId: string,
): Promise<MachineVisualizationState> {
  const definition = serializeMachineDefinition(machine);

  const [currentState, transitions, steps, wakeAt] = await Promise.all([
    DBOS.getEvent<DurableStateSnapshot>(workflowId, "xstate.state", 0.1),
    DBOS.getEvent<TransitionRecord[]>(
      workflowId,
      "xstate.transitions",
      0.1,
    ).then((t) => t ?? []),
    DBOS.listWorkflowSteps(workflowId).then((s) =>
      (s ?? []).map(
        (step): StepInfo => ({
          name: step.name,
          output: step.output,
          error: step.error,
          startedAtEpochMs: step.startedAtEpochMs,
          completedAtEpochMs: step.completedAtEpochMs,
        }),
      ),
    ),
    DBOS.getEvent<number>(workflowId, "xstate.wakeAt", 0.1),
  ]);

  const stateDurations = computeStateDurations(transitions);
  const activeStep = detectActiveStep(steps);
  const activeSleep = wakeAt ? { wakeAt } : null;

  return {
    definition,
    currentState,
    transitions,
    stateDurations,
    activeStep,
    activeSleep,
  };
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
