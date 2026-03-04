// Public API
export { createDurableMachine } from "./create-durable-machine.js";
export type { DurableMachine } from "./create-durable-machine.js";

// Core markers
export { quiescent, isQuiescent } from "./quiescent.js";
export { prompt, getPromptConfig, getPromptEvents } from "./prompt.js";

// Validation
export { validateMachineForDurability } from "./validate.js";

// External client helpers
export { sendMachineEvent, getMachineState } from "./client.js";

// XState utilities
export {
  getActiveInvocation,
  extractActorImplementations,
  getSortedAfterDelays,
  buildAfterEvent,
  isReentryDelay,
  resolveTransientTransitions,
  serializeSnapshot,
  stateValueEquals,
} from "./xstate-utils.js";

// Types
export type {
  DurableStateSnapshot,
  InvocationInfo,
  PromptConfig,
  ChoicePrompt,
  ConfirmPrompt,
  TextInputPrompt,
  FormPrompt,
  FormField,
  PromptOption,
  DurableMachineHandle,
  DurableMachineStatus,
  DurableMachineOptions,
  StepRetryPolicy,
  StepInfo,
} from "./types.js";

export {
  DurableMachineError,
  DurableMachineValidationError,
} from "./types.js";
