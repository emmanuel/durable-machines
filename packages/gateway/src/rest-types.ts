import type { DurableMachine, InstanceStatus } from "@durable-xstate/durable-machine";
import type { MiddlewareHandler } from "hono";

/** Map of machine name → DurableMachine instance. */
export type MachineRegistry = Map<string, DurableMachine>;

/** Options for {@link createRestApi}. */
export interface RestApiOptions {
  /** Map of machine name → DurableMachine. */
  machines: MachineRegistry;
  /** Base path prefix for all routes. @defaultValue `""` */
  basePath?: string;
  /** Optional tenant middleware for multi-tenant JWT auth. */
  tenantMiddleware?: MiddlewareHandler;
  /** Resolve a tenant-scoped DurableMachine by tenantId. */
  getMachineForTenant?: (tenantId: string, machineName: string) => DurableMachine | undefined;
}

/** HATEOAS links included in every state response. */
export interface HateoasLinks {
  /** URL to read current state. */
  self: string;
  /** URL to send events to this instance. */
  send: string;
  /** Available event types the machine accepts in its current state. */
  events: string[];
  /** URL to read the final result (when machine reaches a final state). */
  result: string;
  /** URL to list durable steps executed so far. */
  steps: string;
  /** URL to cancel the instance. */
  cancel: string;
  /** URL to list effect execution status (when effect handlers are configured). */
  effects: string;
}

/** Standard state response body. */
export interface StateResponse {
  /** The machine instance ID. */
  instanceId: string;
  /** Current state value. */
  state: unknown;
  /** Current context. */
  context: Record<string, unknown>;
  /** Workflow lifecycle status. */
  status: InstanceStatus;
  /** HATEOAS navigation links. */
  links: HateoasLinks;
}

/** Error response body. */
export interface ErrorResponse {
  error: string;
  detail?: string;
}

/** Value object identifying a specific machine instance within the REST API. */
export interface InstanceRef {
  basePath: string;
  machineId: string;
  instanceId: string;
}
