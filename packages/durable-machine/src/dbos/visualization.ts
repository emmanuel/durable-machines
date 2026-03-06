import { DBOS } from "@dbos-inc/dbos-sdk";
import type { AnyStateMachine } from "xstate";
import { serializeMachineDefinition, computeStateDurations, detectActiveStep } from "../visualization.js";
import type {
  DurableStateSnapshot,
  TransitionRecord,
  MachineVisualizationState,
  StepInfo,
} from "../types.js";

/**
 * Combines static machine definition with DBOS runtime data for a complete
 * visualization snapshot.
 *
 * Transition history is stored via `setEvent("xstate.transitions", ...)` as
 * an accumulating array (not `writeStream`) so reads are always non-blocking,
 * even for in-progress workflows.
 *
 * @param machine - The XState machine definition
 * @param workflowId - The DBOS workflow ID of the running instance
 * @returns A {@link MachineVisualizationState} combining definition, current state, and timing data
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
