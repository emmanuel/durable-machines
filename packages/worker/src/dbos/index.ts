export {
  createDBOSWorkerAppContext,
  createDBOSWorkerContext,
  startDBOSWorker,
} from "./lifecycle.js";
export type {
  DBOSWorkerContext,
  DBOSWorkerHandle,
} from "./lifecycle.js";

// Re-export generic worker types for consumers migrating from DBOS-specific types
export { parseWorkerConfig } from "../lifecycle.js";
export type { WorkerConfig, WorkerContextOptions } from "../lifecycle.js";
