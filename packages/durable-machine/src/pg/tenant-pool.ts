import type { Pool, PoolClient, QueryConfig, QueryResult } from "pg";

/**
 * Creates a proxy pool that wraps every query with the appropriate
 * SET LOCAL ROLE and tenant GUC inside a transaction.
 *
 * For tenant-scoped access:
 *   createTenantPool(pool, tenantId, "dm_tenant")
 *
 * For admin (unscoped) access:
 *   createTenantPool(pool, null, "dm_admin")
 */
export function createTenantPool(
  pool: Pool,
  tenantId: string | null,
  role: "dm_tenant" | "dm_admin",
): Pool {
  async function scopedQuery(
    configOrText: string | QueryConfig,
    values?: unknown[],
  ): Promise<QueryResult> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      if (tenantId != null) {
        await client.query({
          text: `SELECT set_config('app.tenant_id', $1, true)`,
          values: [tenantId],
        });
      }

      const result =
        typeof configOrText === "string"
          ? await client.query(configOrText, values)
          : await client.query(configOrText);

      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function scopedConnect(): Promise<PoolClient> {
    const client = await pool.connect();
    const originalQuery = client.query.bind(client);

    const wrappedClient = Object.create(client) as PoolClient;

    wrappedClient.query = async function query(
      configOrText: unknown,
      values?: unknown,
    ): Promise<unknown> {
      const text =
        typeof configOrText === "string"
          ? configOrText
          : (configOrText as QueryConfig)?.text;

      // Intercept BEGIN to inject role/GUC
      if (text && /^\s*BEGIN/i.test(text)) {
        const result = await originalQuery(configOrText as string, values as unknown[]);
        await originalQuery(`SET LOCAL ROLE ${role}`);
        if (tenantId != null) {
          await originalQuery({
            text: `SELECT set_config('app.tenant_id', $1, true)`,
            values: [tenantId],
          });
        }
        return result;
      }

      return originalQuery(configOrText as string, values as unknown[]);
    } as PoolClient["query"];

    wrappedClient.release = () => client.release();

    return wrappedClient;
  }

  return {
    query: scopedQuery,
    connect: scopedConnect,
    end: () => pool.end(),
    on: pool.on?.bind(pool),
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  } as unknown as Pool;
}
