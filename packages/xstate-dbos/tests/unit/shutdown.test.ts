import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@dbos-inc/dbos-sdk", () => ({
  DBOS: {
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  gracefulShutdown,
  isShuttingDown,
  _resetShutdownState,
} from "../../src/shutdown.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

type SignalHandler = (...args: unknown[]) => void;

let listeners: Map<string, SignalHandler[]>;

function mockServer() {
  return {
    close: vi.fn((cb?: () => void) => cb?.()),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetShutdownState();
  delete process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS;

  listeners = new Map();
  vi.spyOn(process, "on").mockImplementation((event: string, handler: SignalHandler) => {
    const list = listeners.get(event) ?? [];
    list.push(handler);
    listeners.set(event, list);
    return process;
  });

  vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
    return undefined as never;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function emit(event: string, ...args: unknown[]) {
  for (const handler of listeners.get(event) ?? []) {
    handler(...args);
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("gracefulShutdown", () => {
  it("flips isShuttingDown on first signal, ignores duplicate shutdown", async () => {
    const onShutdown = vi.fn();
    gracefulShutdown({ onShutdown });

    expect(isShuttingDown()).toBe(false);

    emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);

    expect(isShuttingDown()).toBe(true);
    // onShutdown called exactly once even if we try again programmatically
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("second signal forces immediate exit(1)", async () => {
    gracefulShutdown();

    emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(process.exit).mockClear();

    emit("SIGTERM");

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("force-closes connections at 80% of timeout, hard-exits at 100%", async () => {
    const server = {
      close: vi.fn(), // never resolves — simulates stuck connections
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    gracefulShutdown({ servers: [server as never], timeoutMs: 10_000 });

    emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);

    // Before 80%: no force-close
    await vi.advanceTimersByTimeAsync(7_999);
    expect(server.closeAllConnections).not.toHaveBeenCalled();

    // At 80% (8000ms): force-close stragglers
    await vi.advanceTimersByTimeAsync(1);
    expect(server.closeAllConnections).toHaveBeenCalled();

    // At 100% (10000ms): hard exit
    expect(process.exit).not.toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("env var overrides options.timeoutMs", async () => {
    process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS = "2000";
    const server = mockServer();
    // Pass a large timeoutMs that should be ignored
    gracefulShutdown({ servers: [server as never], timeoutMs: 50_000 });

    emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);

    // 80% of 2000 = 1600 — if the env var is ignored, this wouldn't fire yet
    await vi.advanceTimersByTimeAsync(1_600);
    expect(server.closeAllConnections).toHaveBeenCalled();
  });

  it("returned function triggers shutdown programmatically", async () => {
    const onShutdown = vi.fn();
    const shutdown = gracefulShutdown({ onShutdown });

    await shutdown();

    expect(isShuttingDown()).toBe(true);
    expect(onShutdown).toHaveBeenCalledWith("programmatic");
  });
});
