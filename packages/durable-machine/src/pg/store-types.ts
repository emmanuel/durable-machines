import type { Pool, PoolClient } from "pg";
import type { StateValue } from "xstate";
import type { StepInfo, TransitionRecord, InstanceStatus, EffectOutboxStatus, TaskKind } from "../types.js";
import type { ResolvedEffect } from "../effects.js";
import type { StoreInstruments } from "./store-metrics.js";
import {
  Q_LIST_INSTANCES, Q_LIST_INSTANCES_BY_MACHINE, Q_LIST_INSTANCES_BY_STATUS,
  Q_LIST_INSTANCES_BY_MACHINE_AND_STATUS,
  Q_GET_EVENT_LOG, Q_GET_EVENT_LOG_AFTER, Q_GET_EVENT_LOG_LIMIT,
  Q_GET_EVENT_LOG_AFTER_LIMIT,
} from "./queries.js";

export interface PgStoreOptions {
  pool: Pool;
  schema?: string;
  useListenNotify?: boolean;
  instruments?: StoreInstruments;
}

export interface TenantRow {
  id: string;
  jwtIss: string;
  jwtAud: string;
  jwksUrl: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface MachineRow {
  id: string;
  tenantId: string;
  machineName: string;
  stateValue: StateValue;
  context: Record<string, unknown>;
  status: InstanceStatus;
  firedDelays: Array<string | number>;
  wakeAt: number | null;
  wakeEvent: unknown | null;
  input: Record<string, unknown> | null;
  eventCursor: number;
  createdAt: number;
  updatedAt: number;
}

export interface EventLogEntry {
  seq: number;
  topic: string;
  payload: unknown;
  source: string | null;
  createdAt: number;
}

export interface EffectOutboxRow {
  id: string;
  instanceId: string;
  tenantId: string;
  stateValue: StateValue;
  effectType: string;
  effectPayload: Record<string, unknown>;
  status: EffectOutboxStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface TaskOutboxRow extends EffectOutboxRow {
  taskKind: TaskKind;
  machineName: string | null;
  invokeId: string | null;
  invokeSrc: string | null;
  invokeInput: unknown | null;
}

export interface CreateInstanceParams {
  id: string;
  machineName: string;
  stateValue: StateValue;
  context: Record<string, unknown>;
  input: Record<string, unknown> | null;
  wakeAt?: number | null;
  firedDelays?: Array<string | number>;
  queryable?: PoolClient;
  wakeEvent?: unknown;
}

export interface FinalizeParams {
  client: PoolClient;
  instanceId: string;
  stateValue: StateValue;
  context: Record<string, unknown>;
  wakeAt: number | null;
  wakeEvent: unknown | null;
  firedDelays: Array<string | number>;
  status: InstanceStatus;
  eventCursor: number;
}

export interface TransitionData {
  fromState: StateValue | null;
  toState: StateValue;
  event: string | null;
  ts: number;
  contextSnapshot?: Record<string, unknown> | null;
}

export interface SetStepCacheParams {
  instanceId: string;
  stepKey: string;
  output: unknown;
  error?: unknown;
  startedAt?: number;
  completedAt?: number;
  /** When provided, wraps the INSERT in a transaction that sets the tenant GUC. */
  tenantId?: string;
}

export interface QueueInvokeTaskParams {
  client: PoolClient;
  instanceId: string;
  machineName: string;
  invokeId: string;
  invokeSrc: string;
  invokeInput: unknown;
  stateValue: StateValue;
  maxAttempts?: number;
}

export interface InsertEffectsParams {
  client: PoolClient;
  instanceId: string;
  machineName?: string;
  stateValue: StateValue;
  effects: ResolvedEffect[];
  maxAttempts?: number;
}

// ─── Analytics Result Types ──────────────────────────────────────────────────

export interface StateDurationRow {
  stateValue: StateValue;
  enteredAt: number;
  exitedAt: number | null;
}

export interface AggregateStateDuration {
  stateValue: StateValue;
  avgMs: number;
  minMs: number;
  maxMs: number;
  count: number;
}

export interface TransitionCountRow {
  fromState: StateValue | null;
  toState: StateValue;
  event: string | null;
  count: number;
}

export interface InstanceSummaryRow {
  instanceId: string;
  machineName: string;
  status: string;
  startedAt: number;
  updatedAt: number;
  currentState: StateValue;
  totalTransitions: number;
}

// ─── Row Mappers & Query Dispatch ────────────────────────────────────────────

/** Strip dangerous keys to prevent prototype pollution from deserialized JSON. */
export function sanitizeContext(obj: unknown): Record<string, unknown> {
  if (typeof obj !== "object" || obj === null) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    result[key] = value;
  }
  return result;
}

export function rowToMachine(row: any): MachineRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    machineName: row.machine_name,
    stateValue: row.state_value as StateValue,
    context: sanitizeContext(row.context),
    status: row.status as InstanceStatus,
    firedDelays: row.fired_delays as Array<string | number>,
    wakeAt: row.wake_at != null ? Number(row.wake_at) : null,
    wakeEvent: row.wake_event ?? null,
    input: row.input as Record<string, unknown> | null,
    eventCursor: Number(row.event_cursor),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function rowToEffect(row: any): EffectOutboxRow {
  return {
    id: row.id,
    instanceId: row.instance_id,
    tenantId: row.tenant_id,
    stateValue: row.state_value as StateValue,
    effectType: row.effect_type,
    effectPayload: row.effect_payload as Record<string, unknown>,
    status: row.status as EffectOutboxStatus,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lastError: row.last_error ?? null,
    createdAt: Number(row.created_at),
    completedAt: row.completed_at != null ? Number(row.completed_at) : null,
  };
}

export function rowToTask(row: any): TaskOutboxRow {
  return {
    ...rowToEffect(row),
    taskKind: row.task_kind ?? "effect",
    machineName: row.machine_name ?? null,
    invokeId: row.invoke_id ?? null,
    invokeSrc: row.invoke_src ?? null,
    invokeInput: row.invoke_input ?? null,
  };
}

export function rowToEventLog(r: any): EventLogEntry {
  return {
    seq: Number(r.seq),
    topic: r.topic as string,
    payload: r.payload,
    source: r.source as string | null,
    createdAt: Number(r.created_at),
  };
}

export function pickListQuery(
  machineName?: string,
  status?: string,
): [{ name: string; text: string }, unknown[]] {
  if (machineName && status) return [Q_LIST_INSTANCES_BY_MACHINE_AND_STATUS, [machineName, status]];
  if (machineName) return [Q_LIST_INSTANCES_BY_MACHINE, [machineName]];
  if (status) return [Q_LIST_INSTANCES_BY_STATUS, [status]];
  return [Q_LIST_INSTANCES, []];
}

export function pickEventLogQuery(
  instanceId: string,
  afterSeq?: number,
  limit?: number,
): [{ name: string; text: string }, unknown[]] {
  if (afterSeq !== undefined && limit !== undefined) return [Q_GET_EVENT_LOG_AFTER_LIMIT, [instanceId, afterSeq, limit]];
  if (afterSeq !== undefined) return [Q_GET_EVENT_LOG_AFTER, [instanceId, afterSeq]];
  if (limit !== undefined) return [Q_GET_EVENT_LOG_LIMIT, [instanceId, limit]];
  return [Q_GET_EVENT_LOG, [instanceId]];
}

// ─── PgStore Interface ──────────────────────────────────────────────────────

export interface PgStore {
  // Transaction management
  withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;

  // Schema
  ensureSchema(): Promise<void>;
  /** Create PG roles (dm_tenant, dm_admin) and enable RLS policies. */
  ensureRoles(): Promise<void>;

  // Instance CRUD
  createInstance(params: CreateInstanceParams): Promise<void>;
  getInstance(id: string): Promise<MachineRow | null>;
  updateInstanceStatus(id: string, status: InstanceStatus): Promise<void>;
  updateInstanceSnapshot(
    client: PoolClient,
    id: string,
    stateValue: StateValue,
    context: Record<string, unknown>,
  ): Promise<void>;
  listInstances(filter?: {
    machineName?: string;
    status?: InstanceStatus | string;
  }): Promise<MachineRow[]>;

  // Locking
  lockAndGetInstance(
    client: PoolClient,
    id: string,
  ): Promise<MachineRow | null>;

  // Event log
  appendEvent(
    instanceId: string,
    payload: unknown,
    topic?: string,
    source?: string,
  ): Promise<{ seq: number }>;

  lockAndPeekEvent(
    client: PoolClient,
    instanceId: string,
  ): Promise<{
    row: MachineRow;
    nextEvent: { seq: number; payload: unknown } | null;
  } | null>;

  lockAndPeekEvents(
    client: PoolClient,
    instanceId: string,
    limit: number,
  ): Promise<{
    row: MachineRow;
    events: Array<{ seq: number; payload: unknown }>;
  } | null>;

  getEventLog(
    instanceId: string,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<EventLogEntry[]>;

  // Step cache (used by prompt-lifecycle for idempotent prompt tracking)
  getStepCache(
    instanceId: string,
    stepKey: string,
  ): Promise<{ output: unknown; error: unknown } | null>;
  setStepCache(params: SetStepCacheParams): Promise<void>;

  // Task queue (invoke + effect outbox)
  queueInvokeTask(params: QueueInvokeTaskParams): Promise<void>;
  claimPendingTasks(limit?: number): Promise<TaskOutboxRow[]>;
  checkInvokeEventExists(instanceId: string, idempotencyKey: string): Promise<boolean>;
  cancelInvokeTask(client: PoolClient, instanceId: string, invokeId: string): Promise<void>;
  cancelInstanceInvokes(instanceId: string): Promise<void>;
  checkTaskStatus(taskId: string): Promise<EffectOutboxStatus | null>;
  appendEventWithKey(
    instanceId: string,
    payload: unknown,
    idempotencyKey: string,
    topic?: string,
    source?: string,
  ): Promise<{ seq: number } | null>;
  getInvokeSteps(instanceId: string): Promise<StepInfo[]>;

  // CTE finalize
  finalizeInstance(params: FinalizeParams): Promise<void>;
  finalizeWithTransition(params: FinalizeParams & TransitionData): Promise<void>;

  // Transition log
  appendTransition(
    instanceId: string,
    fromState: StateValue | null,
    toState: StateValue,
    event: string | null,
    ts: number,
    contextSnapshot?: Record<string, unknown> | null,
    tenantId?: string,
  ): Promise<void>;
  getTransitions(instanceId: string): Promise<TransitionRecord[]>;

  // Effect outbox
  insertEffects(params: InsertEffectsParams): Promise<void>;
  markEffectCompleted(effectId: string): Promise<void>;
  markEffectFailed(effectId: string, error: string, nextRetryAt: number | null): Promise<void>;
  listEffects(instanceId: string): Promise<EffectOutboxRow[]>;
  /** Reset tasks stuck in "executing" since before `olderThanMs` back to "pending". Returns count of reset rows. */
  resetStaleEffects(olderThanMs: number): Promise<number>;

  // Analytics (read-only, query transition_log directly)
  getStateDurations(instanceId: string): Promise<StateDurationRow[]>;
  getAggregateStateDurations(machineName: string): Promise<AggregateStateDuration[]>;
  getTransitionCounts(machineName: string): Promise<TransitionCountRow[]>;
  getInstanceSummaries(machineName: string): Promise<InstanceSummaryRow[]>;

  // LISTEN/NOTIFY
  startListening(
    eventCallback: (machineName: string, instanceId: string, topic: string) => void,
    taskCallback?: (instanceId: string) => void,
  ): Promise<void>;
  stopListening(): Promise<void>;

  // Tenant scoping
  /** Returns a PgStore scoped to a specific tenant via RLS. */
  forTenant(tenantId: string): PgStore;

  // Lifecycle
  close(): Promise<void>;
}
