import type { AppContext, AppContextOptions } from "./types.js";

/**
 * Callbacks a backend provides to `createAppContext()` so the shared
 * factory can compose signal handling + shutdown sequencing around them.
 */
export interface AppContextBackend {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Creates an {@link AppContext} that wraps a backend's start/stop callbacks
 * with signal handling, shutdown sequencing, and HTTP server draining.
 */
export function createAppContext(backend: AppContextBackend): AppContext {
  let shuttingDown = false;
  let options: AppContextOptions | undefined;
  let signalsWired = false;

  function wireSignalHandlers(): void {
    if (signalsWired) return;
    signalsWired = true;

    const signals = options?.signals ?? ["SIGTERM", "SIGINT"];
    let secondSignal = false;
    for (const sig of signals) {
      process.on(sig, () => {
        if (secondSignal) process.exit(1);
        secondSignal = true;
        void shutdown(sig);
      });
    }

    if (options?.handleExceptions !== false) {
      process.on("uncaughtException", (err) => {
        void shutdown(`uncaughtException: ${err.message}`);
      });
      process.on("unhandledRejection", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        void shutdown(`unhandledRejection: ${message}`);
      });
    }
  }

  async function drainServers(timeoutMs: number): Promise<void> {
    const servers = options?.servers;
    if (!servers?.length) return;

    const forceTimeout = setTimeout(() => {
      for (const s of servers) s.closeAllConnections();
    }, Math.floor(timeoutMs * 0.8));
    forceTimeout.unref();

    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.closeIdleConnections();
            s.close(() => resolve());
          }),
      ),
    );
    clearTimeout(forceTimeout);
  }

  async function shutdown(reason?: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    options?.onShutdown?.(reason ?? "shutdown");

    const timeoutMs = options?.timeoutMs ?? 30_000;
    const deadline = setTimeout(() => process.exit(1), timeoutMs);
    deadline.unref();

    await backend.stop();
    await drainServers(timeoutMs);

    clearTimeout(deadline);
    process.exit(0);
  }

  return {
    async start(opts) {
      options = opts;
      await backend.start();
      wireSignalHandlers();
    },
    shutdown,
    isShuttingDown() {
      return shuttingDown;
    },
  };
}
