import { DBOS } from "@dbos-inc/dbos-sdk";
import type { AnyStateMachine, AnyEventObject } from "xstate";
import type {
  DurableMachine,
  DurableMachineOptions,
  DurableStateSnapshot,
  DurableMachineHandle,
  StepInfo,
} from "../types.js";
import { validateMachineForDurability } from "../validate.js";
import { createMachineLoop } from "./machine-loop.js";

// Cache registered workflows by name to avoid double-registration
const registeredWorkflows = new Map<string, (...args: any[]) => Promise<any>>();

/**
 * Creates a durable XState machine backed by DBOS workflows.
 *
 * **Must be called before `DBOS.launch()`** — DBOS requires all workflow
 * registrations to happen before the runtime starts.
 *
 * Validates the machine definition at registration time and registers
 * a DBOS workflow for the machine's lifecycle loop.
 *
 * @param machine - The XState machine definition to make durable
 * @param options - Optional configuration for the durable machine (e.g., channel adapters)
 * @returns A {@link DurableMachine} facade for starting, retrieving, and listing instances
 * @throws {@link DurableMachineValidationError} if the machine fails durability validation
 *
 * @example
 * ```ts
 * const durable = createDurableMachine(orderMachine);
 * await DBOS.launch();
 * const handle = await durable.start("order-123", { orderId: "123" });
 * ```
 */
export function createDurableMachine<T extends AnyStateMachine>(
  machine: T,
  options?: DurableMachineOptions,
): DurableMachine<T> {
  validateMachineForDurability(machine);

  const opts = options ?? {};
  const workflowName = `xstate:${machine.id}`;

  // Reuse existing registration if createDurableMachine is called
  // multiple times with the same machine id
  let workflow = registeredWorkflows.get(workflowName);
  if (!workflow) {
    const loop = createMachineLoop(machine, opts);
    workflow = DBOS.registerWorkflow(loop, { name: workflowName });
    registeredWorkflows.set(workflowName, workflow);
  }

  return {
    machine,

    async start(workflowId, input) {
      const handle = await DBOS.startWorkflow(workflow, {
        workflowID: workflowId,
      })(input);
      return createHandle(workflowId, handle);
    },

    get(workflowId) {
      const handle = DBOS.retrieveWorkflow(workflowId);
      return createHandle(workflowId, handle);
    },

    async list(filter) {
      const statuses = await DBOS.listWorkflows({
        workflowName,
        status: filter?.status as any,
      });
      return statuses.map((s) => ({
        workflowId: s.workflowID,
        status: s.status,
        workflowName: s.workflowName,
      }));
    },
  };
}

/**
 * Creates a `DurableMachineHandle` wrapping a DBOS `WorkflowHandle`.
 */
function createHandle(
  workflowId: string,
  dbosHandle: { getResult(): Promise<any>; workflowID: string },
): DurableMachineHandle {
  return {
    workflowId,

    async send(event: AnyEventObject): Promise<void> {
      await DBOS.send(workflowId, event, "xstate.event");
    },

    async getState(): Promise<DurableStateSnapshot | null> {
      return DBOS.getEvent<DurableStateSnapshot>(
        workflowId,
        "xstate.state",
        0.1, // Short timeout — return null if not yet published
      );
    },

    async getResult(): Promise<Record<string, unknown>> {
      return dbosHandle.getResult();
    },

    async getSteps(): Promise<StepInfo[]> {
      const steps = await DBOS.listWorkflowSteps(workflowId);
      if (!steps) return [];
      return steps.map((s) => ({
        name: s.name,
        output: s.output,
        error: s.error,
        startedAtEpochMs: s.startedAtEpochMs,
        completedAtEpochMs: s.completedAtEpochMs,
      }));
    },

    async cancel(): Promise<void> {
      await DBOS.cancelWorkflow(workflowId);
    },
  };
}
