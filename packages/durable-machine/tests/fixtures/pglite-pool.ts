import type { PGliteInterface, Results } from "@electric-sql/pglite";
import type { Pool, PoolClient, QueryConfig, QueryResult } from "pg";

/**
 * Wraps a PGlite instance to provide the subset of pg.Pool / pg.PoolClient
 * used by PgStore, so unit tests can run against an in-memory PGlite
 * instead of requiring a Docker PostgreSQL container.
 *
 * Supported surface:
 *   pool.query(text)                    – plain or multi-statement SQL
 *   pool.query({ name?, text, values }) – prepared-statement-style config
 *   pool.connect() → PoolClient         – returns a thin wrapper
 *   client.query(…)                     – same signatures as pool.query
 *   client.release()                    – no-op (single connection)
 *   pool.end()                          – closes the PGlite instance
 *   Result: { rows, rowCount }
 */
export function createPgLitePool(db: PGliteInterface): Pool {
  function mapResult(result: Results): QueryResult {
    return {
      rows: result.rows as any[],
      rowCount: result.affectedRows ?? 0,
      command: "",
      oid: 0,
      fields: result.fields.map((f) => ({
        name: f.name,
        dataTypeID: f.dataTypeID,
        tableID: 0,
        columnID: 0,
        dataTypeSize: 0,
        dataTypeModifier: 0,
        format: "",
      })),
    };
  }

  async function query(
    configOrText: string | QueryConfig,
    values?: any[],
  ): Promise<QueryResult> {
    let text: string;
    let params: any[] | undefined;

    if (typeof configOrText === "string") {
      text = configOrText;
      params = values;
    } else {
      text = configOrText.text;
      params = configOrText.values ?? values;
    }

    // Parameterized → single statement via db.query()
    if (params && params.length > 0) {
      return mapResult(await db.query(text, params));
    }

    // No params → exec() handles multi-statement SQL (e.g. SCHEMA_SQL)
    const results = await db.exec(text);
    if (results.length === 0) {
      return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
    }
    return mapResult(results[results.length - 1]);
  }

  function createClient(): PoolClient {
    return { query, release() {} } as unknown as PoolClient;
  }

  return {
    query,
    connect: async () => createClient(),
    end: async () => db.close(),
  } as unknown as Pool;
}
