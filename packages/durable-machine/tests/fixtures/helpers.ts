/**
 * Shared test helpers and the BackendFixture interface used by conformance tests.
 */
import type { AnyStateMachine } from "xstate";
import type {
  DurableMachine,
  DurableMachineHandle,
  DurableMachineOptions,
  MachineVisualizationState,
} from "../../src/types.js";


/**
 * Backend-agnostic fixture that conformance tests use to create and manage
 * durable machines. Each backend provides its own implementation.
 */
export interface BackendFixture {
  /** Display name for test output (e.g. "dbos", "pg"). */
  name: string;

  /** Called once before all tests in a suite — launch runtime, connect DB, etc. */
  setup(): Promise<void>;

  /** Called once after all tests — shut down runtime, clean up. */
  teardown(): Promise<void>;

  /** Create a durable machine backed by this runtime. */
  createMachine(
    machine: AnyStateMachine,
    options?: DurableMachineOptions,
  ): DurableMachine;

  /**
   * Get visualization state for a workflow. Optional — only implemented by
   * backends that support visualization.
   */
  getVisualizationState?(
    machine: AnyStateMachine,
    workflowId: string,
  ): Promise<MachineVisualizationState>;
}

/**
 * Polls `handle.getState()` until the state value matches `expected`.
 */
export async function waitForState(
  handle: Pick<DurableMachineHandle, "getState">,
  expected: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await handle.getState();
    if (state && JSON.stringify(state.value) === JSON.stringify(expected)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for state "${expected}"`);
}

/**
 * Polls `handle.getState()` until a context predicate returns true.
 */
export async function waitForContext(
  handle: Pick<DurableMachineHandle, "getState">,
  predicate: (ctx: any) => boolean,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await handle.getState();
    if (state?.context && predicate(state.context)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for context predicate");
}

/**
 * Creates a console channel adapter that records prompts for test assertions.
 * Re-exported here so conformance tests don't need to import from src directly.
 */
export { consoleChannel } from "../../src/channels/console.js";
