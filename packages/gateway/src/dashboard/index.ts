import type { MachineRegistry } from "../rest-types.js";
import { createDashboardRoutes } from "./routes.js";
import type { Hono } from "hono";

export interface DashboardOptions {
  /** Map of machine name to DurableMachine instance. */
  machines: MachineRegistry;
  /** Where the dashboard is mounted (for link generation). @defaultValue `"/dashboard"` */
  basePath?: string;
  /** Base path of the REST API (for the event sender form action). @defaultValue `""` */
  restBasePath?: string;
  /** Optional PgStore — enables NOTIFY-driven SSE instead of polling. */
  store?: {
    startListening(
      callback: (machineName: string, instanceId: string, topic: string) => void,
    ): Promise<void>;
    stopListening(): Promise<void>;
  };
  /** Fallback poll interval in milliseconds (when store is not provided). @defaultValue `2000` */
  pollIntervalMs?: number;
}

/**
 * Creates the dashboard Hono sub-app.
 *
 * @example
 * ```ts
 * const dashboard = createDashboard({ machines });
 * gateway.route("/dashboard", dashboard);
 * ```
 */
export function createDashboard(options: DashboardOptions): Hono {
  const {
    machines,
    basePath = "/dashboard",
    restBasePath = "",
    store,
    pollIntervalMs = 2000,
  } = options;

  return createDashboardRoutes({
    machines,
    basePath,
    restBasePath,
    store,
    pollIntervalMs,
  });
}
