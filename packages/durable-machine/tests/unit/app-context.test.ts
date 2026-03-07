import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAppContext } from "../../src/app-context.js";
import type { AppContextBackend } from "../../src/app-context.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

type SignalHandler = (...args: unknown[]) => void;

let listeners: Map<string, SignalHandler[]>;

function emit(event: string, ...args: unknown[]) {
  for (const handler of listeners.get(event) ?? []) {
    handler(...args);
  }
}

function mockServer() {
  return {
    close: vi.fn((cb?: () => void) => cb?.()),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
  };
}

function mockBackend(): AppContextBackend & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.useFakeTimers();

  listeners = new Map();
  vi.spyOn(process, "on").mockImplementation(
    (event: string | symbol, handler: (...args: any[]) => void) => {
      const key = typeof event === "symbol" ? event.toString() : event;
      const list = listeners.get(key) ?? [];
      list.push(handler);
      listeners.set(key, list);
      return process;
    },
  );

  vi.spyOn(process, "exit").mockImplementation(
    (_code?: string | number | null) => {
      return undefined as never;
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createAppContext", () => {
  it("calls backend.start() on start", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);

    await ctx.start();

    expect(backend.start).toHaveBeenCalledOnce();
  });

  it("wires signal handlers after start", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);

    await ctx.start();

    expect(listeners.has("SIGTERM")).toBe(true);
    expect(listeners.has("SIGINT")).toBe(true);
  });

  it("wires exception handlers by default", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);

    await ctx.start();

    expect(listeners.has("uncaughtException")).toBe(true);
    expect(listeners.has("unhandledRejection")).toBe(true);
  });

  it("skips exception handlers when handleExceptions is false", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);

    await ctx.start({ handleExceptions: false });

    expect(listeners.has("uncaughtException")).toBe(false);
    expect(listeners.has("unhandledRejection")).toBe(false);
  });

  it("isShuttingDown starts false and becomes true on shutdown", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);

    await ctx.start();
    expect(ctx.isShuttingDown()).toBe(false);

    void ctx.shutdown("test");
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.isShuttingDown()).toBe(true);
  });

  it("calls onShutdown callback", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);
    const onShutdown = vi.fn();

    await ctx.start({ onShutdown });

    void ctx.shutdown("test-reason");
    await vi.advanceTimersByTimeAsync(0);

    expect(onShutdown).toHaveBeenCalledWith("test-reason");
  });

  it("double shutdown is idempotent", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);
    const onShutdown = vi.fn();

    await ctx.start({ onShutdown });

    void ctx.shutdown("first");
    await vi.advanceTimersByTimeAsync(0);
    void ctx.shutdown("second");
    await vi.advanceTimersByTimeAsync(0);

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(backend.stop).toHaveBeenCalledTimes(1);
  });

  it("calls backend.stop() during shutdown", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);

    await ctx.start();

    void ctx.shutdown("test");
    await vi.advanceTimersByTimeAsync(0);

    expect(backend.stop).toHaveBeenCalledOnce();
  });

  it("drains servers during shutdown", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);
    const server = mockServer();

    await ctx.start({ servers: [server as never] });

    void ctx.shutdown("test");
    await vi.advanceTimersByTimeAsync(0);

    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();
  });

  it("signal triggers shutdown", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);

    await ctx.start();
    expect(ctx.isShuttingDown()).toBe(false);

    emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.isShuttingDown()).toBe(true);
    expect(backend.stop).toHaveBeenCalledOnce();
  });

  it("second signal forces exit(1)", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);

    await ctx.start();

    emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(process.exit).mockClear();

    emit("SIGTERM");

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("force-closes connections at 80% of timeout", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);
    const server = {
      close: vi.fn(), // never resolves — simulates stuck connections
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };

    await ctx.start({ servers: [server as never], timeoutMs: 10_000 });

    emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);

    // Before 80%: no force-close
    await vi.advanceTimersByTimeAsync(7_999);
    expect(server.closeAllConnections).not.toHaveBeenCalled();

    // At 80% (8000ms): force-close stragglers
    await vi.advanceTimersByTimeAsync(1);
    expect(server.closeAllConnections).toHaveBeenCalled();
  });

  it("hard deadline backstop exits at 100% of timeout", async () => {
    const backend: AppContextBackend = {
      start: vi.fn().mockResolvedValue(undefined),
      // stop never resolves — simulates hung backend
      stop: vi.fn((): Promise<void> => new Promise(() => {})),
    };
    const ctx = createAppContext(backend);

    await ctx.start({ timeoutMs: 5_000 });

    emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);

    expect(process.exit).not.toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("uses custom signals", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);

    await ctx.start({ signals: ["SIGUSR1"] });

    expect(listeners.has("SIGTERM")).toBe(false);
    expect(listeners.has("SIGUSR1")).toBe(true);

    emit("SIGUSR1");
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.isShuttingDown()).toBe(true);
  });

  it("uncaughtException triggers shutdown", async () => {
    const backend = mockBackend();
    const ctx = createAppContext(backend);

    await ctx.start();

    emit("uncaughtException", new Error("boom"));
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.isShuttingDown()).toBe(true);
  });
});
