import { describe, it, expect, vi } from "vitest";
import type { GatewayContext } from "../../src/lifecycle.js";
import { startGateway } from "../../src/lifecycle.js";

/**
 * Minimal stub of GatewayContext for testing startGateway cleanup wiring.
 * Does NOT bind real ports (we skip Hono serve by directly testing the
 * ctx.cleanup and shutdown functions).
 */
function createStubContext(overrides?: Partial<GatewayContext>): GatewayContext {
  return {
    config: { port: 0, adminPort: 0, shutdownTimeoutMs: 5_000 },
    client: { send: vi.fn(), sendBatch: vi.fn(), getState: vi.fn() },
    metrics: {} as any,
    gateway: { fetch: vi.fn() } as any,
    adminServer: stubServer(),
    ...overrides,
  };
}

function stubServer() {
  const s: any = {
    listen: vi.fn(),
    close: vi.fn((cb: () => void) => cb()),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
  };
  return s;
}

function stubStreamConsumer() {
  const stopped = Promise.resolve();
  return { stop: vi.fn(), stopped };
}

// We need to mock @hono/node-server since we don't want real HTTP
vi.mock("@hono/node-server", () => ({
  serve: vi.fn(() => stubServer()),
}));

describe("startGateway cleanup wiring", () => {
  it("sets ctx.cleanup after startGateway", () => {
    const ctx = createStubContext();
    expect(ctx.cleanup).toBeUndefined();

    startGateway(ctx);

    expect(ctx.cleanup).toBeTypeOf("function");
  });

  it("cleanup stops stream consumers and closes checkpoint pool", async () => {
    const consumer1 = stubStreamConsumer();
    const consumer2 = stubStreamConsumer();
    const pool = { end: vi.fn(async () => {}) };

    const ctx = createStubContext({
      streamConsumers: [consumer1, consumer2],
      checkpointPool: pool as any,
    });

    startGateway(ctx);
    await ctx.cleanup!();

    expect(consumer1.stop).toHaveBeenCalledOnce();
    expect(consumer2.stop).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("cleanup is a no-op when no streams or pool", async () => {
    const ctx = createStubContext();
    startGateway(ctx);

    // Should not throw
    await ctx.cleanup!();
  });

  it("standalone shutdown calls cleanup then drains servers", async () => {
    const consumer = stubStreamConsumer();
    const pool = { end: vi.fn(async () => {}) };
    const adminServer = stubServer();

    const ctx = createStubContext({
      streamConsumers: [consumer],
      checkpointPool: pool as any,
      adminServer,
    });

    const handle = startGateway(ctx);
    await handle.shutdown();

    // Cleanup happened: consumer stopped, pool closed
    expect(consumer.stop).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();

    // Admin server was drained
    expect(adminServer.closeIdleConnections).toHaveBeenCalled();
    expect(adminServer.close).toHaveBeenCalled();
  });
});
