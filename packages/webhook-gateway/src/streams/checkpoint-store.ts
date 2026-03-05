import type { CheckpointStore, StreamCursor } from "./types.js";

/** In-memory checkpoint store (testing). */
export function memoryCheckpointStore(): CheckpointStore {
  const store = new Map<string, StreamCursor>();
  return {
    async load(streamId: string): Promise<StreamCursor | null> {
      return store.get(streamId) ?? null;
    },
    async save(streamId: string, cursor: StreamCursor): Promise<void> {
      store.set(streamId, cursor);
    },
  };
}

/** PostgreSQL pool interface — matches `pg.Pool` without importing it. */
interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** PostgreSQL checkpoint store. Caller owns the pool. */
export function pgCheckpointStore(pool: PgPool): CheckpointStore & {
  /** Creates the stream_checkpoints table. Call during startup. */
  ensureTable(): Promise<void>;
} {
  return {
    async ensureTable(): Promise<void> {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stream_checkpoints (
          stream_id TEXT PRIMARY KEY,
          cursor JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    },

    async load(streamId: string): Promise<StreamCursor | null> {
      const result = await pool.query(
        "SELECT cursor FROM stream_checkpoints WHERE stream_id = $1",
        [streamId],
      );
      if (result.rows.length === 0) return null;
      return result.rows[0].cursor as StreamCursor;
    },

    async save(streamId: string, cursor: StreamCursor): Promise<void> {
      await pool.query(
        `INSERT INTO stream_checkpoints (stream_id, cursor, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (stream_id)
         DO UPDATE SET cursor = $2, updated_at = NOW()`,
        [streamId, JSON.stringify(cursor)],
      );
    },
  };
}
