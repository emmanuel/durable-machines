import { describe, it, expect } from "vitest";
import { parseWorkerConfig } from "../../src/lifecycle.js";

describe("parseWorkerConfig", () => {
  it("returns defaults when env is empty", () => {
    const config = parseWorkerConfig({});

    expect(config.adminPort).toBeUndefined();
    expect(config.shutdownTimeoutMs).toBe(30_000);
  });

  it("parses valid ADMIN_PORT and GRACEFUL_SHUTDOWN_TIMEOUT_MS", () => {
    const config = parseWorkerConfig({
      ADMIN_PORT: "9091",
      GRACEFUL_SHUTDOWN_TIMEOUT_MS: "5000",
    });

    expect(config.adminPort).toBe(9091);
    expect(config.shutdownTimeoutMs).toBe(5000);
  });

  it("throws on non-numeric ADMIN_PORT", () => {
    expect(() =>
      parseWorkerConfig({ ADMIN_PORT: "not-a-number" }),
    ).toThrow("Invalid worker config");
  });

  it("throws on negative GRACEFUL_SHUTDOWN_TIMEOUT_MS", () => {
    expect(() =>
      parseWorkerConfig({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: "-1" }),
    ).toThrow("Invalid worker config");
  });

  it("accepts a custom env record", () => {
    const env = { ADMIN_PORT: "8080" };
    const config = parseWorkerConfig(env);

    expect(config.adminPort).toBe(8080);
    expect(config.shutdownTimeoutMs).toBe(30_000);
  });
});
