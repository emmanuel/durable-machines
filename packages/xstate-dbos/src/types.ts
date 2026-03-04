import type { StateValue, AnyEventObject } from "xstate";

// ─── Durable State ──────────────────────────────────────────────────────────

export interface DurableStateSnapshot {
  value: StateValue;
  context: Record<string, unknown>;
  status: "running" | "done" | "error";
}

// ─── Invocation ─────────────────────────────────────────────────────────────

export interface InvocationInfo {
  /** The invoke `id` (used in done/error event types) */
  id: string;
  /** The `src` actor name */
  src: string;
  /** Resolved input for the actor */
  input: unknown;
}

// ─── Prompt Types ───────────────────────────────────────────────────────────

export interface PromptOption {
  label: string;
  event: string;
  style?: "primary" | "danger" | "default";
}

export interface ChoicePrompt {
  type: "choice";
  text: string | ((params: { context: Record<string, unknown> }) => string);
  options: PromptOption[];
  recipient?: string | ((params: { context: Record<string, unknown> }) => string);
}

export interface ConfirmPrompt {
  type: "confirm";
  text: string | ((params: { context: Record<string, unknown> }) => string);
  confirmEvent: string;
  cancelEvent: string;
  recipient?: string | ((params: { context: Record<string, unknown> }) => string);
}

export interface TextInputPrompt {
  type: "text_input";
  text: string | ((params: { context: Record<string, unknown> }) => string);
  event: string;
  placeholder?: string;
  recipient?: string | ((params: { context: Record<string, unknown> }) => string);
}

export interface FormField {
  name: string;
  label: string;
  type: "text" | "number" | "select" | "date";
  options?: string[];
  required?: boolean;
}

export interface FormPrompt {
  type: "form";
  text: string | ((params: { context: Record<string, unknown> }) => string);
  fields: FormField[];
  event: string;
  recipient?: string | ((params: { context: Record<string, unknown> }) => string);
}

export type PromptConfig = ChoicePrompt | ConfirmPrompt | TextInputPrompt | FormPrompt;

// ─── Machine Handle / API ───────────────────────────────────────────────────

export interface DurableMachineHandle<TContext = Record<string, unknown>> {
  readonly workflowId: string;
  send(event: AnyEventObject): Promise<void>;
  getState(): Promise<DurableStateSnapshot | null>;
  getResult(): Promise<TContext>;
  getSteps(): Promise<StepInfo[]>;
  cancel(): Promise<void>;
}

export interface DurableMachineStatus {
  workflowId: string;
  status: string;
  workflowName: string;
}

export interface StepInfo {
  name: string;
  output: unknown;
  error: unknown;
  startedAtEpochMs?: number;
  completedAtEpochMs?: number;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface StepRetryPolicy {
  retriesAllowed?: boolean;
  maxAttempts?: number;
  intervalSeconds?: number;
  backoffRate?: number;
}

export interface DurableMachineOptions {
  maxWaitSeconds?: number;
  stepRetryPolicy?: StepRetryPolicy;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class DurableMachineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableMachineError";
  }
}

export class DurableMachineValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: string[]) {
    super(
      `Machine validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
    this.name = "DurableMachineValidationError";
    this.errors = errors;
  }
}
