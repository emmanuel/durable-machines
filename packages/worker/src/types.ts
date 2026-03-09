import type { AnyStateMachine } from "xstate";
import type {
  AppContext,
  DurableMachine,
  DurableMachineOptions,
} from "@durable-xstate/durable-machine";

/** Extends {@link AppContext} with machine registration for worker processes. */
export interface WorkerAppContext extends AppContext {
  /** Register a machine and return a DAO handle. */
  register<T extends AnyStateMachine>(
    machine: T,
    options?: DurableMachineOptions,
  ): DurableMachine<T>;
}

/** Pino-compatible logger interface. */
export interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}
