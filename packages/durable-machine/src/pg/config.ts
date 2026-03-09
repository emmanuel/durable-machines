export interface PgConfig {
  databaseUrl: string;
  schema?: string;
  wakePollingIntervalMs?: number;
  effectPollingIntervalMs?: number;
  useListenNotify?: boolean;
  maxConcurrency?: number;
  poolSize?: number;
}

/**
 * Reads PG backend configuration from environment variables (or a provided map).
 *
 * | Env var                    | Type    | Default    | Description                               |
 * |----------------------------|---------|------------|-------------------------------------------|
 * | `DATABASE_URL`             | string  | *(required)* | Postgres connection URL                 |
 * | `PG_SCHEMA`                | string  | `"public"` | Schema for all tables                     |
 * | `WAKE_POLLING_INTERVAL_MS`   | number  | `5000`     | Timeout poll interval                     |
 * | `EFFECT_POLLING_INTERVAL_MS` | number  | `1000`     | Effect outbox poll interval               |
 * | `PG_USE_LISTEN_NOTIFY`       | boolean | `true`     | Set `false` for PgBouncer transaction mode|
 * | `MAX_CONCURRENCY`            | number  | `10`       | Max concurrent instance processing        |
 * | `PG_POOL_SIZE`               | number  | `20`       | PG connection pool max size               |
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

  if (env.EFFECT_POLLING_INTERVAL_MS) {
    const val = Number(env.EFFECT_POLLING_INTERVAL_MS);
    if (Number.isNaN(val) || val <= 0) {
      throw new Error(
        `EFFECT_POLLING_INTERVAL_MS must be a positive number, got "${env.EFFECT_POLLING_INTERVAL_MS}"`,
      );
    }
    config.effectPollingIntervalMs = val;
  }

  if (env.PG_USE_LISTEN_NOTIFY !== undefined) {
    config.useListenNotify =
      env.PG_USE_LISTEN_NOTIFY !== "false" && env.PG_USE_LISTEN_NOTIFY !== "0";
  }

  if (env.MAX_CONCURRENCY) {
    const val = Number(env.MAX_CONCURRENCY);
    if (Number.isNaN(val) || val <= 0) {
      throw new Error(
        `MAX_CONCURRENCY must be a positive number, got "${env.MAX_CONCURRENCY}"`,
      );
    }
    config.maxConcurrency = val;
  }

  if (env.PG_POOL_SIZE) {
    const val = Number(env.PG_POOL_SIZE);
    if (Number.isNaN(val) || val <= 0) {
      throw new Error(
        `PG_POOL_SIZE must be a positive number, got "${env.PG_POOL_SIZE}"`,
      );
    }
    config.poolSize = val;
  }

  return config;
}
