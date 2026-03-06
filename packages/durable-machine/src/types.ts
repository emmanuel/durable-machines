import type { StateValue, AnyEventObject, AnyStateMachine } from "xstate";

// ─── Durable State ──────────────────────────────────────────────────────────

/**
 * A serializable snapshot of a durable state machine at a point in time.
 * Used to persist and restore machine state across workflow steps.
 */
export interface DurableStateSnapshot {
  /** Current XState state value. A string for simple states, or a nested object for parallel/compound states. */
  value: StateValue;
  /** The machine's extended state (context data) at the time of this snapshot. */
  context: Record<string, unknown>;
  /** Workflow lifecycle status: `"running"` while active, `"done"` when the machine reaches a final state, `"error"` on failure. */
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

/** A single selectable option within a choice prompt. */
export interface PromptOption {
  /** Display text shown to the user for this option. */
  label: string;
  /** The XState event type dispatched when this option is selected. */
  event: string;
  /** Visual hint for rendering the option (e.g. `"danger"` for destructive actions). Defaults to `"default"`. */
  style?: "primary" | "danger" | "default";
}

/** A prompt that presents the user with a list of discrete choices. */
export interface ChoicePrompt {
  /** Discriminator for the prompt union. Always `"choice"`. */
  type: "choice";
  /** Instructional text displayed above the options. May be a static string or a function that derives text from the current machine context. */
  text: string | ((params: { context: Record<string, unknown> }) => string);
  /** The set of selectable options presented to the user. */
  options: PromptOption[];
  /** Optional routing hint indicating who should receive this prompt (e.g. a user ID, role, or channel name). May be derived from context. */
  recipient?: string | ((params: { context: Record<string, unknown> }) => string);
}

/** A prompt that asks the user for a binary confirm/cancel decision. */
export interface ConfirmPrompt {
  /** Discriminator for the prompt union. Always `"confirm"`. */
  type: "confirm";
  /** The confirmation question displayed to the user. May be a static string or derived from context. */
  text: string | ((params: { context: Record<string, unknown> }) => string);
  /** XState event type dispatched when the user confirms. */
  confirmEvent: string;
  /** XState event type dispatched when the user cancels. */
  cancelEvent: string;
  /** Optional routing hint indicating who should receive this prompt. May be derived from context. */
  recipient?: string | ((params: { context: Record<string, unknown> }) => string);
}

/** A prompt that collects free-form text input from the user. */
export interface TextInputPrompt {
  /** Discriminator for the prompt union. Always `"text_input"`. */
  type: "text_input";
  /** Instructional text displayed above the input field. May be a static string or derived from context. */
  text: string | ((params: { context: Record<string, unknown> }) => string);
  /** XState event type dispatched with the entered text as payload. */
  event: string;
  /** Placeholder text shown inside the empty input field. */
  placeholder?: string;
  /** Optional routing hint indicating who should receive this prompt. May be derived from context. */
  recipient?: string | ((params: { context: Record<string, unknown> }) => string);
}

/** Describes a single field within a {@link FormPrompt}. */
export interface FormField {
  /** The key used to identify this field's value in the submitted event payload. */
  name: string;
  /** Human-readable label displayed alongside the field. */
  label: string;
  /** The input control type. Use `"select"` with {@link options} to present a dropdown. */
  type: "text" | "number" | "select" | "date";
  /** Available choices when `type` is `"select"`. Ignored for other field types. */
  options?: string[];
  /** Whether the field must be filled before submission. */
  required?: boolean;
}

/** A prompt that collects structured data via multiple form fields. */
export interface FormPrompt {
  /** Discriminator for the prompt union. Always `"form"`. */
  type: "form";
  /** Instructional text displayed above the form. May be a static string or derived from context. */
  text: string | ((params: { context: Record<string, unknown> }) => string);
  /** The ordered list of fields rendered in the form. */
  fields: FormField[];
  /** XState event type dispatched with the form data as payload on submission. */
  event: string;
  /** Optional routing hint indicating who should receive this prompt. May be derived from context. */
  recipient?: string | ((params: { context: Record<string, unknown> }) => string);
}

/**
 * Union of all supported prompt types. The `type` discriminator determines
 * which variant is active.
 */
export type PromptConfig = ChoicePrompt | ConfirmPrompt | TextInputPrompt | FormPrompt;

// ─── Machine Handle / API ───────────────────────────────────────────────────

/**
 * A handle to a running durable state machine instance. Provides methods
 * to interact with and observe the machine from outside.
 *
 * @typeParam TContext - The shape of the machine's context. Defaults to `Record<string, unknown>`.
 */
export interface DurableMachineHandle<TContext = Record<string, unknown>> {
  /** The unique workflow/instance ID for this machine instance. */
  readonly workflowId: string;
  /** Dispatch an event to the running machine. The event is durably enqueued and processed in the workflow loop. */
  send(event: AnyEventObject): Promise<void>;
  /** Retrieve the current state snapshot, or `null` if the machine has not yet initialized. */
  getState(): Promise<DurableStateSnapshot | null>;
  /** Wait for the machine to reach a final state and return its final context. Rejects if the machine errors. */
  getResult(): Promise<TContext>;
  /** Return the ordered list of durable steps executed by this workflow so far. */
  getSteps(): Promise<StepInfo[]>;
  /** Cancel the running workflow. The machine will not process further events. */
  cancel(): Promise<void>;
}

/** Summary status of a durable machine instance, typically returned when listing active instances. */
export interface DurableMachineStatus {
  /** The unique workflow/instance ID. */
  workflowId: string;
  /** Current workflow status (e.g. `"PENDING"`, `"SUCCESS"`, `"ERROR"`). */
  status: string;
  /** The registered machine/workflow name. */
  workflowName: string;
}

/**
 * A durable XState machine that can start, retrieve, and list instances.
 * Backend-agnostic — both DBOS and PG backends return this interface.
 *
 * @typeParam T - The XState machine type
 */
export interface DurableMachine<T extends AnyStateMachine = AnyStateMachine> {
  /** Start a new durable machine instance. */
  start(
    workflowId: string,
    input: Record<string, unknown>,
  ): Promise<DurableMachineHandle>;

  /** Get a handle to an existing machine instance by workflow ID. */
  get(workflowId: string): DurableMachineHandle;

  /** List machine instances, optionally filtered by status. */
  list(filter?: { status?: string }): Promise<DurableMachineStatus[]>;

  /** The underlying XState machine definition. */
  readonly machine: T;
}

/** Metadata for a single durable step executed within a workflow. */
export interface StepInfo {
  /** The step name, matching the DBOS step function name or a user-supplied label. */
  name: string;
  /** The value returned by the step on success, or `undefined` if the step has not completed or errored. */
  output: unknown;
  /** The error thrown by the step on failure, or `undefined` if the step succeeded or has not completed. */
  error: unknown;
  /** Unix epoch timestamp (milliseconds) when the step began execution. */
  startedAtEpochMs?: number;
  /** Unix epoch timestamp (milliseconds) when the step finished. `undefined` if still running. */
  completedAtEpochMs?: number;
}

// ─── Channel Adapters ───────────────────────────────────────────────────────

/** Parameters passed to {@link ChannelAdapter.sendPrompt}. */
export interface SendPromptParams {
  /** The workflow ID of the machine that triggered the prompt. */
  workflowId: string;
  /** The XState state value at the time the prompt was emitted. */
  stateValue: StateValue;
  /** The prompt configuration declared on the current state node. */
  prompt: PromptConfig;
  /** The machine context at the time the prompt was emitted. */
  context: Record<string, unknown>;
}

/** Parameters passed to {@link ChannelAdapter.resolvePrompt}. */
export interface ResolvePromptParams {
  /** The opaque handle returned by a prior {@link ChannelAdapter.sendPrompt} call. */
  handle: unknown;
  /** The event that resolved the prompt (i.e. the user's response). */
  event: AnyEventObject;
  /** The new XState state value after the resolving event was processed. */
  newStateValue: StateValue;
}

/** Parameters passed to {@link ChannelAdapter.updatePrompt}. */
export interface UpdatePromptParams {
  /** The opaque handle returned by a prior {@link ChannelAdapter.sendPrompt} call. */
  handle: unknown;
  /** The (possibly updated) prompt configuration for the current state node. */
  prompt: PromptConfig;
  /** The current machine context, which may have changed since the prompt was first sent. */
  context: Record<string, unknown>;
}

/**
 * Adapts prompt metadata into a concrete delivery mechanism (Slack, email,
 * console, etc.). The machine declares *what* to ask; the adapter decides
 * *how* to render it.
 */
export interface ChannelAdapter {
  /** Render a prompt to the user. Returns an opaque handle for later updates. */
  sendPrompt(params: SendPromptParams): Promise<{ handle: unknown }>;

  /** Update the prompt after the user responds (e.g. replace buttons with outcome text). */
  resolvePrompt?(params: ResolvePromptParams): Promise<void>;

  /** Update the prompt when context changes within the same state. */
  updatePrompt?(params: UpdatePromptParams): Promise<void>;
}

// ─── Visualization ─────────────────────────────────────────────────────────

/** A JSON-serializable representation of a single XState state node, used for visualization and inspection. */
export interface SerializedStateNode {
  /** Dot-delimited path from the machine root (e.g. `"idle"`, `"processing.validating"`). */
  path: string;
  /** The XState state node type. */
  type: "atomic" | "compound" | "parallel" | "final" | "history";
  /** `true` if this state is marked as durable (the workflow loop will pause and wait for external input). */
  durable?: boolean;
  /** The prompt configuration attached to this state, if any. */
  prompt?: PromptConfig;
  /** Invoked actors declared on this state node. */
  invoke?: { id: string; src: string }[];
  /** Delayed (`after`) transitions declared on this state node. */
  after?: {
    delay: number | string;
    target?: string;
    reenter?: boolean;
    guard?: string;
  }[];
  /** Eventless (`always`) transitions declared on this state node. */
  always?: { target?: string; guard?: string }[];
  /** Event-driven transitions, keyed by event type. */
  on?: Record<string, { target?: string; guard?: string }[]>;
  /** Paths of direct child state nodes (for compound/parallel states). */
  children?: string[];
}

/** A JSON-serializable representation of an entire XState machine definition. */
export interface SerializedMachine {
  /** The machine's unique identifier. */
  id: string;
  /** The path of the initial state node. */
  initial: string;
  /** Flattened map of all state nodes, keyed by their dot-delimited path. */
  states: Record<string, SerializedStateNode>;
}

/** Records a single state transition for visualization and debugging. */
export interface TransitionRecord {
  /** The state value before the transition, or `null` for the initial transition. */
  from: StateValue | null;
  /** The state value after the transition. */
  to: StateValue;
  /** Unix epoch timestamp (milliseconds) when the transition occurred. */
  ts: number;
}

/** Tracks how long the machine stayed in a particular state. */
export interface StateDuration {
  /** The state value being measured. */
  state: StateValue;
  /** Unix epoch timestamp (milliseconds) when the machine entered this state. */
  enteredAt: number;
  /** Unix epoch timestamp (milliseconds) when the machine exited this state, or `null` if still active. */
  exitedAt: number | null;
  /** Elapsed time in milliseconds. Updated in real time while the state is active. */
  durationMs: number;
}

/** Aggregate visualization state for a running durable machine, suitable for rendering a live dashboard or debugger. */
export interface MachineVisualizationState {
  /** The static machine definition (graph structure). */
  definition: SerializedMachine;
  /** The machine's current state snapshot, or `null` if not yet initialized. */
  currentState: DurableStateSnapshot | null;
  /** Ordered list of all state transitions observed so far. */
  transitions: TransitionRecord[];
  /** Duration measurements for each state the machine has visited. */
  stateDurations: StateDuration[];
  /** The currently executing durable step, or `null` if the machine is idle or waiting. */
  activeStep: StepInfo | null;
  /** If the machine is sleeping (e.g. an `after` delay), the epoch timestamp when it will wake. Otherwise `null`. */
  activeSleep: { wakeAt: number } | null;
}

// ─── Options ────────────────────────────────────────────────────────────────

/** Controls how failed durable steps are retried. All fields are optional and fall back to sensible defaults. */
export interface StepRetryPolicy {
  /** Whether retries are enabled at all. @defaultValue `true` */
  retriesAllowed?: boolean;
  /** Maximum number of attempts (including the initial attempt). @defaultValue `3` */
  maxAttempts?: number;
  /** Base interval in seconds between retry attempts. @defaultValue `1` */
  intervalSeconds?: number;
  /** Exponential backoff multiplier applied to `intervalSeconds` after each retry. @defaultValue `2` */
  backoffRate?: number;
}

/** Configuration options for a durable machine workflow. */
export interface DurableMachineOptions {
  /** Maximum seconds the workflow loop will block waiting for an external event before timing out. @defaultValue `300` (5 minutes) */
  maxWaitSeconds?: number;
  /** Retry policy applied to all durable steps unless individually overridden. */
  stepRetryPolicy?: StepRetryPolicy;
  /** Channel adapters for delivering prompts to external systems (Slack, email, console, etc.). */
  channels?: ChannelAdapter[];
  /** When `true`, the workflow emits a transition stream that visualization tools can subscribe to. */
  enableTransitionStream?: boolean;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/** General runtime error thrown by the durable machine infrastructure (e.g. timeout, unexpected state). */
export class DurableMachineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableMachineError";
  }
}

/**
 * Thrown at registration time when a machine definition fails validation.
 * Inspect the {@link errors} array for individual diagnostic messages.
 */
export class DurableMachineValidationError extends Error {
  /** List of human-readable validation error descriptions. */
  readonly errors: readonly string[];

  constructor(errors: string[]) {
    super(
      `Machine validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
    this.name = "DurableMachineValidationError";
    this.errors = errors;
  }
}
