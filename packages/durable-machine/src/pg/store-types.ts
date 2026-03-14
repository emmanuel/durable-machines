import type { Pool, PoolClient } from "pg";
import type { StateValue } from "xstate";
import type { StepInfo, TransitionRecord, InstanceStatus, EffectOutboxStatus } from "../types.js";
import type { ResolvedEffect } from "../effects.js";
import type { StoreInstruments } from "./store-metrics.js";

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

export interface RecordInvokeResultParams {
  instanceId: string;
  stepKey: string;
  output: unknown;
  error?: unknown;
  startedAt?: number;
  completedAt?: number;
}

export interface InsertEffectsParams {
  client: PoolClient;
  instanceId: string;
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

  // Invoke results
  getInvokeResult(
    instanceId: string,
    stepKey: string,
  ): Promise<{ output: unknown; error: unknown } | null>;
  recordInvokeResult(params: RecordInvokeResultParams): Promise<void>;
  listInvokeResults(instanceId: string): Promise<StepInfo[]>;

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
  ): Promise<void>;
  getTransitions(instanceId: string): Promise<TransitionRecord[]>;

  // Effect outbox
  insertEffects(params: InsertEffectsParams): Promise<void>;
  claimPendingEffects(limit?: number): Promise<EffectOutboxRow[]>;
  markEffectCompleted(effectId: string): Promise<void>;
  markEffectFailed(effectId: string, error: string, nextRetryAt: number | null): Promise<void>;
  listEffects(instanceId: string): Promise<EffectOutboxRow[]>;
  /** Reset effects stuck in "executing" since before `olderThanMs` back to "pending". Returns count of reset rows. */
  resetStaleEffects(olderThanMs: number): Promise<number>;

  // Analytics (read-only, query transition_log directly)
  getStateDurations(instanceId: string): Promise<StateDurationRow[]>;
  getAggregateStateDurations(machineName: string): Promise<AggregateStateDuration[]>;
  getTransitionCounts(machineName: string): Promise<TransitionCountRow[]>;
  getInstanceSummaries(machineName: string): Promise<InstanceSummaryRow[]>;

  // LISTEN/NOTIFY
  startListening(
    callback: (machineName: string, instanceId: string, topic: string) => void,
  ): Promise<void>;
  stopListening(): Promise<void>;

  // Tenant scoping
  /** Returns a PgStore scoped to a specific tenant via RLS. */
  forTenant(tenantId: string): PgStore;

  // Lifecycle
  close(): Promise<void>;
}
