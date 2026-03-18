import type { AnyStateMachine } from "xstate";
import {
  serializeMachineDefinition,
  computeStateDurations,
  detectActiveStep,
} from "../visualization.js";
import type { MachineVisualizationState } from "../types.js";
import type { PgStore } from "./store.js";

/**
 * Combines static machine definition with PG runtime data for a complete
 * visualization snapshot.
 */
export async function getVisualizationState(
  machine: AnyStateMachine,
  workflowId: string,
  store: PgStore,
): Promise<MachineVisualizationState> {
  const definition = serializeMachineDefinition(machine);

  const [row, transitions, steps] = await Promise.all([
    store.getInstance(workflowId),
    store.getTransitions(workflowId),
    store.getInvokeSteps(workflowId),
  ]);

  const currentState = row
    ? {
        value: row.stateValue,
        context: row.context,
        status: (row.status === "done"
          ? "done"
          : row.status === "error"
            ? "error"
            : "running") as "running" | "done" | "error",
      }
    : null;

  const stateDurations = computeStateDurations(transitions);
  const activeStep = detectActiveStep(steps);
  const activeSleep = row?.wakeAt ? { wakeAt: row.wakeAt } : null;

  return {
    definition,
    currentState,
    transitions,
    stateDurations,
    activeStep,
    activeSleep,
  };
}
