import type { Pool } from "pg";
import type { MachineDefinition } from "../definition/types.js";
import type { ImplementationRegistry } from "../definition/registry.js";
import type { DurableMachineOptions } from "../types.js";
import type { PgStore } from "../pg/store.js";

/** Result from dm_process_events() — only the fields Node.js needs. */
export interface NativeProcessResult {
  processed: number;
  status: string;
  invocation: { id: string; src: string; input: unknown } | null;
}

/** Result from dm_create_instance() */
export interface NativeCreateResult {
  status: string;
  invocation: { id: string; src: string; input: unknown } | null;
}

export interface PgNativeDurableMachineOptions extends DurableMachineOptions {
  pool: Pool;
  machineName: string;
  /** If provided, registered in machine_definitions on first use. */
  definition?: MachineDefinition;
  store?: PgStore;
  /** Implementation registry for actors, guards, actions, delays. Required when definition references actors. */
  registry?: ImplementationRegistry;
}
