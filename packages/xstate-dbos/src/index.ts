// Public API
export { createDurableMachine } from "./create-durable-machine.js";
export type { DurableMachine } from "./create-durable-machine.js";

// Core markers
export { quiescent, isQuiescent } from "./quiescent.js";
export { prompt, getPromptConfig, getPromptEvents } from "./prompt.js";

// Validation
export { validateMachineForDurability, walkStateNodes } from "./validate.js";

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

// Visualization
export {
  serializeMachineDefinition,
  getVisualizationState,
  computeStateDurations,
  detectActiveStep,
} from "./visualization.js";

// Channel adapters
export { consoleChannel } from "./console-channel.js";
export type { ConsoleChannel, ConsolePromptRecord } from "./console-channel.js";

// Types
export type {
  SerializedMachine,
  SerializedStateNode,
  TransitionRecord,
  StateDuration,
  MachineVisualizationState,
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
  ChannelAdapter,
  SendPromptParams,
  ResolvePromptParams,
  UpdatePromptParams,
} from "./types.js";

export {
  DurableMachineError,
  DurableMachineValidationError,
} from "./types.js";
