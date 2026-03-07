export interface PgConfig {
  databaseUrl: string;
  schema?: string;
  wakePollingIntervalMs?: number;
  effectPollingIntervalMs?: number;
  useListenNotify?: boolean;
}

/**
 * Reads PG backend configuration from environment variables (or a provided map).
 *
 * | Env var                    | Type    | Default    | Description                               |
 * |----------------------------|---------|------------|-------------------------------------------|
 * | `DATABASE_URL`             | string  | *(required)* | Postgres connection URL                 |
 * | `PG_SCHEMA`                | string  | `"public"` | Schema for all tables                     |
 * | `WAKE_POLLING_INTERVAL_MS` | number  | `5000`     | Timeout poll interval                     |
 * | `PG_USE_LISTEN_NOTIFY`     | boolean | `true`     | Set `false` for PgBouncer transaction mode|
 */
export function parsePgConfig(
  env: Record<string, string | undefined> = process.env,
): PgConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const config: PgConfig = { databaseUrl };

  if (env.PG_SCHEMA) {
    config.schema = env.PG_SCHEMA;
  }

  if (env.WAKE_POLLING_INTERVAL_MS) {
    const val = Number(env.WAKE_POLLING_INTERVAL_MS);
    if (Number.isNaN(val) || val <= 0) {
      throw new Error(
        `WAKE_POLLING_INTERVAL_MS must be a positive number, got "${env.WAKE_POLLING_INTERVAL_MS}"`,
      );
    }
    config.wakePollingIntervalMs = val;
  }

  if (env.PG_USE_LISTEN_NOTIFY !== undefined) {
    config.useListenNotify =
      env.PG_USE_LISTEN_NOTIFY !== "false" && env.PG_USE_LISTEN_NOTIFY !== "0";
  }

  return config;
}
