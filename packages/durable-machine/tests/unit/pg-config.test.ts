import { describe, it, expect } from "vitest";
import { parsePgConfig } from "../../src/pg/config.js";

describe("parsePgConfig", () => {
  it("reads DATABASE_URL", () => {
    const config = parsePgConfig({ DATABASE_URL: "postgresql://localhost/test" });
    expect(config.databaseUrl).toBe("postgresql://localhost/test");
  });

  it("throws on missing DATABASE_URL", () => {
    expect(() => parsePgConfig({})).toThrow("DATABASE_URL");
  });

  it("parses optional numeric values", () => {
    const config = parsePgConfig({
      DATABASE_URL: "postgresql://localhost/test",
      WAKE_POLLING_INTERVAL_MS: "2000",
    });
    expect(config.wakePollingIntervalMs).toBe(2000);
  });

  it("throws on invalid numeric values", () => {
    expect(() =>
      parsePgConfig({
        DATABASE_URL: "postgresql://localhost/test",
        WAKE_POLLING_INTERVAL_MS: "not-a-number",
      }),
    ).toThrow("WAKE_POLLING_INTERVAL_MS");
  });

  it("parses PG_SCHEMA", () => {
    const config = parsePgConfig({
      DATABASE_URL: "postgresql://localhost/test",
      PG_SCHEMA: "myschema",
    });
    expect(config.schema).toBe("myschema");
  });

  it("parses PG_USE_LISTEN_NOTIFY=false", () => {
    const config = parsePgConfig({
      DATABASE_URL: "postgresql://localhost/test",
      PG_USE_LISTEN_NOTIFY: "false",
    });
    expect(config.useListenNotify).toBe(false);
  });

  it("parses PG_USE_LISTEN_NOTIFY=true", () => {
    const config = parsePgConfig({
      DATABASE_URL: "postgresql://localhost/test",
      PG_USE_LISTEN_NOTIFY: "true",
    });
    expect(config.useListenNotify).toBe(true);
  });

  it("accepts custom env map", () => {
    const env = { DATABASE_URL: "postgresql://custom/db" };
    const config = parsePgConfig(env);
    expect(config.databaseUrl).toBe("postgresql://custom/db");
  });
});
