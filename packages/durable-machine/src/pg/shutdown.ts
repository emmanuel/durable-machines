import type { Server } from "node:http";
import type { Pool } from "pg";
import type { PgStore } from "./store.js";

export interface PgShutdownOptions {
  store?: PgStore;
  pool?: Pool;
  servers?: Server[];
  timeoutMs?: number;
  signals?: NodeJS.Signals[];
  onShutdown?: (reason: string) => void;
}

let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Wire signal handlers for graceful process shutdown and return a shutdown
 * function for programmatic use.
 *
 * Shutdown sequence:
 * 1. Set shuttingDown flag
 * 2. Stop LISTEN client
 * 3. Close HTTP servers
 * 4. Drain pool
 * 5. Exit
 */
export function gracefulShutdown(
  options: PgShutdownOptions = {},
): () => Promise<void> {
  const {
    store,
    pool,
    servers = [],
    signals = ["SIGTERM", "SIGINT"],
    onShutdown,
  } = options;

  const envTimeout = process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS;
  const timeoutMs = envTimeout
    ? Number(envTimeout)
    : (options.timeoutMs ?? 30_000);

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    onShutdown?.(reason);

    const backstop = setTimeout(() => {
      process.exit(1);
    }, timeoutMs);
    backstop.unref();

    // Stop LISTEN client
    if (store) {
      await store.stopListening();
    }

    // 80% drain timer
    const drainDeadline = setTimeout(() => {
      for (const server of servers) {
        server.closeAllConnections();
      }
    }, Math.floor(timeoutMs * 0.8));
    drainDeadline.unref();

    // Close servers
    const serverClosePromises = servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
        }),
    );
    await Promise.all(serverClosePromises);

    // Close store (stops listener)
    if (store) {
      await store.close();
    }

    // Drain pool
    if (pool) {
      await pool.end();
    }

    process.exit(0);
  }

  for (const signal of signals) {
    process.on(signal, () => {
      if (shuttingDown) {
        process.exit(1);
      }
      void shutdown(signal);
    });
  }

  return (reason?: string) => shutdown(reason ?? "programmatic");
}
