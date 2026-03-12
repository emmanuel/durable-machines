function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}. Set it or run via docker compose.`);
  return value;
}

export const TEST_DB_URL = requireEnv("PG_TEST_DATABASE_URL");
export const DBOS_SYSTEM_DB_URL =
  process.env.DBOS_SYSTEM_DATABASE_URL ?? TEST_DB_URL;
