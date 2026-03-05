import type { Server } from "node:http";
import { DBOS } from "@dbos-inc/dbos-sdk";

/**
 * Options for {@link gracefulShutdown}.
 */
export interface GracefulShutdownOptions {
  /** HTTP servers to close (e.g. Hono node server). Drained in order, first to last. */
  servers?: Server[];
  /**
   * Max ms to wait for drain before forcing exit. Default: `30_000`.
   * Overridden by `GRACEFUL_SHUTDOWN_TIMEOUT_MS` env var.
   */
  timeoutMs?: number;
  /** Signals to handle. Default: `["SIGTERM", "SIGINT"]`. */
  signals?: NodeJS.Signals[];
  /** Called when shutdown begins (for logging). */
  onShutdown?: (reason: string) => void;
  /** Handle uncaughtException/unhandledRejection. Default: `true`. */
  handleExceptions?: boolean;
}

let shuttingDown = false;

/**
 * Returns `true` if shutdown has been initiated. Use in readiness probes.
 *
 * @example
 * ```ts
 * app.get("/ready", (req, res) => {
 *   res.status(isShuttingDown() ? 503 : 200).end();
 * });
 * ```
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

// Exported for testing — allows resetting module state between tests.
export function _resetShutdownState(): void {
  shuttingDown = false;
}

/**
 * Wire signal handlers for graceful process shutdown and return a shutdown
 * function for programmatic use.
 *
 * Shutdown sequence (following the app-lifecycle patterns):
 * 1. Set `isShuttingDown` flag (readiness probes return 503)
 * 2. Call `onShutdown(reason)` callback
 * 3. For each server: `server.close()` + `server.closeIdleConnections()`;
 *    at 80% of timeout: `server.closeAllConnections()`
 * 4. `DBOS.shutdown()` — stop workflow processing, disconnect DB
 * 5. `process.exit(0)` on success
 * 6. Hard deadline: `setTimeout(timeoutMs)` → `process.exit(1)` backstop
 *
 * @param options - Configuration for the shutdown behavior.
 * @returns An async function that triggers the shutdown sequence programmatically.
 *
 * @example Worker-only (no HTTP server)
 * ```ts
 * await DBOS.launch();
 * gracefulShutdown({
 *   onShutdown: (reason) => console.log(`Shutting down (${reason})...`),
 * });
 * ```
 *
 * @example Worker + gateway (with servers)
 * ```ts
 * const server = serve({ fetch: gateway.fetch, port: 3000 });
 * gracefulShutdown({
 *   servers: [server],
 *   onShutdown: (reason) => console.log(`Shutting down (${reason})...`),
 * });
 * ```
 *
 * @example Custom signals and timeout
 * ```ts
 * const shutdown = gracefulShutdown({
 *   signals: ["SIGTERM"],
 *   timeoutMs: 10_000,
 *   handleExceptions: false,
 * });
 * // Trigger programmatically later:
 * await shutdown();
 * ```
 */
export function gracefulShutdown(
  options: GracefulShutdownOptions = {},
): () => Promise<void> {
  const {
    servers = [],
    signals = ["SIGTERM", "SIGINT"],
    onShutdown,
    handleExceptions = true,
  } = options;

  const envTimeout = process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS;
  const timeoutMs = envTimeout ? Number(envTimeout) : (options.timeoutMs ?? 30_000);

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    onShutdown?.(reason);

    // Hard deadline backstop
    const backstop = setTimeout(() => {
      process.exit(1);
    }, timeoutMs);
    backstop.unref();

    // 80% drain timer — force-close remaining connections
    const drainDeadline = setTimeout(() => {
      for (const server of servers) {
        server.closeAllConnections();
      }
    }, Math.floor(timeoutMs * 0.8));
    drainDeadline.unref();

    // Close servers: stop accepting, drop idle connections
    const serverClosePromises = servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
        }),
    );
    await Promise.all(serverClosePromises);

    // Stop DBOS workflow processing
    await DBOS.shutdown();

    process.exit(0);
  }

  // Register signal handlers
  for (const signal of signals) {
    process.on(signal, () => {
      if (shuttingDown) {
        // Second signal — force exit immediately
        process.exit(1);
      }
      void shutdown(signal);
    });
  }

  // Exception handlers (opt-in, default true)
  if (handleExceptions) {
    process.on("uncaughtException", (err) => {
      void shutdown(`uncaughtException: ${err.message}`);
    });
    process.on("unhandledRejection", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      void shutdown(`unhandledRejection: ${message}`);
    });
  }

  return (reason?: string) => shutdown(reason ?? "programmatic");
}
