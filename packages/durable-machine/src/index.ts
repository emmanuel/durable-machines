// Core markers
export { durableState, isDurableState } from "./durable-state.js";
export { prompt, getPromptConfig, getPromptEvents } from "./prompt.js";
export { createEffectHandlers, getEffectsConfig } from "./effects.js";
export type { EffectConfig, ResolvedEffect, EffectHandler, EffectHandlerRegistry } from "./effects.js";

// Effect collector
export { collectAndResolveEffects } from "./effect-collector.js";

// Validation
export { validateMachineForDurability, walkStateNodes } from "./validate.js";
export type { ValidateOptions } from "./validate.js";

// XState utilities (advanced)
export {
  getActiveInvocation,
  stateValueEquals,
  extractActorImplementations,
  getSortedAfterDelays,
  buildAfterEvent,
  isReentryDelay,
  resolveTransientTransitions,
  serializeSnapshot,
} from "./xstate-utils.js";

// Visualization (pure functions only)
export {
  serializeMachineDefinition,
  computeStateDurations,
  detectActiveStep,
} from "./visualization.js";

// App context
export { createAppContext } from "./app-context.js";
export type { AppContextBackend } from "./app-context.js";

// Channel adapters
export { consoleChannel } from "./channels/console.js";
export type { ConsoleChannel, ConsolePromptRecord } from "./channels/console.js";
export { slackChannel } from "./channels/slack.js";
export type { SlackChannelOptions, SlackPromptHandle } from "./channels/slack.js";
export { emailChannel } from "./channels/email.js";
export type { EmailChannelOptions, EmailPromptHandle, SendEmailParams } from "./channels/email.js";
export { twilioSmsChannel } from "./channels/twilio-sms.js";
export type { TwilioSmsChannelOptions, TwilioSmsPromptHandle } from "./channels/twilio-sms.js";

// Definition (machine-as-data)
export * from "./definition/index.js";

// Types
export type {
  AppContext,
  AppContextOptions,
  WorkerAppContext,
  DurableMachine,
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
  EffectStatus,
  ChannelAdapter,
  SendPromptParams,
  ResolvePromptParams,
  UpdatePromptParams,
} from "./types.js";

export {
  DurableMachineError,
  DurableMachineValidationError,
} from "./types.js";
