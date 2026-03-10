import type { Pool } from "pg";

export interface PgStatSnapshot {
  database: {
    xactCommit: number;
    xactRollback: number;
    blksRead: number;
    blksHit: number;
    tupFetched: number;
    tupInserted: number;
    tupUpdated: number;
    tupDeleted: number;
    deadlocks: number;
  };
  activity: {
    active: number;
    idle: number;
    idleInTransaction: number;
    total: number;
  };
}

export interface PgStatDiff {
  xactCommit: number;
  xactRollback: number;
  blksRead: number;
  blksHit: number;
  cacheHitRatio: number;
  tupFetched: number;
  tupInserted: number;
  tupUpdated: number;
  tupDeleted: number;
  deadlocks: number;
}

export async function snapshotPgStats(pool: Pool): Promise<PgStatSnapshot> {
  const dbResult = await pool.query(`
    SELECT xact_commit, xact_rollback,
           blks_read, blks_hit,
           tup_fetched, tup_inserted, tup_updated, tup_deleted,
           deadlocks
    FROM pg_stat_database
    WHERE datname = current_database()
  `);
  const db = dbResult.rows[0];

  const actResult = await pool.query(`
    SELECT state, count(*)::int AS cnt
    FROM pg_stat_activity
    WHERE datname = current_database()
    GROUP BY state
  `);
  const actMap = new Map<string, number>();
  for (const row of actResult.rows) {
    actMap.set(row.state ?? "null", Number(row.cnt));
  }

  return {
    database: {
      xactCommit: Number(db.xact_commit),
      xactRollback: Number(db.xact_rollback),
      blksRead: Number(db.blks_read),
      blksHit: Number(db.blks_hit),
      tupFetched: Number(db.tup_fetched),
      tupInserted: Number(db.tup_inserted),
      tupUpdated: Number(db.tup_updated),
      tupDeleted: Number(db.tup_deleted),
      deadlocks: Number(db.deadlocks),
    },
    activity: {
      active: actMap.get("active") ?? 0,
      idle: actMap.get("idle") ?? 0,
      idleInTransaction: actMap.get("idle in transaction") ?? 0,
      total: [...actMap.values()].reduce((a, b) => a + b, 0),
    },
  };
}

export function diffPgStats(
  before: PgStatSnapshot,
  after: PgStatSnapshot,
): PgStatDiff {
  const blksRead = after.database.blksRead - before.database.blksRead;
  const blksHit = after.database.blksHit - before.database.blksHit;
  const totalBlks = blksRead + blksHit;

  return {
    xactCommit: after.database.xactCommit - before.database.xactCommit,
    xactRollback: after.database.xactRollback - before.database.xactRollback,
    blksRead,
    blksHit,
    cacheHitRatio: totalBlks > 0 ? blksHit / totalBlks : 1,
    tupFetched: after.database.tupFetched - before.database.tupFetched,
    tupInserted: after.database.tupInserted - before.database.tupInserted,
    tupUpdated: after.database.tupUpdated - before.database.tupUpdated,
    tupDeleted: after.database.tupDeleted - before.database.tupDeleted,
    deadlocks: after.database.deadlocks - before.database.deadlocks,
  };
}

export function formatPgStats(diff: PgStatDiff): string {
  const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return (
    `PG: xact=${k(diff.xactCommit)} | cache_hit=${(diff.cacheHitRatio * 100).toFixed(1)}% | ` +
    `tup_fetched=${k(diff.tupFetched)} | inserted=${k(diff.tupInserted)} | ` +
    `updated=${k(diff.tupUpdated)} | deadlocks=${diff.deadlocks}`
  );
}
