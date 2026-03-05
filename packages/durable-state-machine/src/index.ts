// Public API
export { createDurableMachine } from "./create-durable-machine.js";
export type { DurableMachine } from "./create-durable-machine.js";

// Core markers
export { durableState, isDurableState } from "./durable-state.js";
export { prompt, getPromptConfig, getPromptEvents } from "./prompt.js";

// Validation
export { validateMachineForDurability, walkStateNodes } from "./validate.js";

// External client helpers
export { sendMachineEvent, getMachineState } from "./client.js";

// XState utilities (advanced)
export {
  getActiveInvocation,
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
export { consoleChannel } from "./channels/console.js";
export type { ConsoleChannel, ConsolePromptRecord } from "./channels/console.js";
export { slackChannel } from "./channels/slack.js";
export type { SlackChannelOptions, SlackPromptHandle } from "./channels/slack.js";
export { emailChannel } from "./channels/email.js";
export type { EmailChannelOptions, EmailPromptHandle, SendEmailParams } from "./channels/email.js";
export { twilioSmsChannel } from "./channels/twilio-sms.js";
export type { TwilioSmsChannelOptions, TwilioSmsPromptHandle } from "./channels/twilio-sms.js";

// Lifecycle
export { gracefulShutdown, isShuttingDown } from "./shutdown.js";
export type { GracefulShutdownOptions } from "./shutdown.js";

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
