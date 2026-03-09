import type { AnyStateMachine } from "xstate";
import type {
  AppContext,
  DurableMachine,
  DurableMachineOptions,
  Logger,
} from "@durable-xstate/durable-machine";

/** Extends {@link AppContext} with machine registration for worker processes. */
export interface WorkerAppContext extends AppContext {
  /** Register a machine and return a DAO handle. */
  register<T extends AnyStateMachine>(
    machine: T,
    options?: DurableMachineOptions,
  ): DurableMachine<T>;
}

// Re-export Logger from durable-machine
export type { Logger };
