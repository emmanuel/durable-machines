import type { Pool } from "pg";
import type { AnyEventObject } from "xstate";
import type { DurableStateSnapshot } from "../types.js";
import type { StateValue } from "xstate";

/**
 * Sends an event to a machine instance via direct SQL insert into `event_log`.
 * The NOTIFY trigger will alert the listener for event-driven processing.
 */
export async function sendMachineEvent(
  pool: Pool,
  workflowId: string,
  event: AnyEventObject,
): Promise<void> {
  await pool.query(
    `INSERT INTO event_log (instance_id, topic, payload, created_at)
     VALUES ($1, 'event', $2, $3)`,
    [workflowId, JSON.stringify(event), Date.now()],
  );
}

/**
 * Sends a batch of events to machine instances via a single multi-row INSERT.
 * The NOTIFY trigger fires per-row automatically.
 */
export async function sendMachineEventBatch(
  pool: Pool,
  events: Array<{ workflowId: string; event: AnyEventObject }>,
): Promise<void> {
  if (events.length === 0) return;

  const now = Date.now();
  const instanceIds: string[] = [];
  const topics: string[] = [];
  const payloads: string[] = [];
  const timestamps: number[] = [];

  for (const { workflowId, event } of events) {
    instanceIds.push(workflowId);
    topics.push("event");
    payloads.push(JSON.stringify(event));
    timestamps.push(now);
  }

  await pool.query(
    `INSERT INTO event_log (instance_id, topic, payload, created_at)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::jsonb[], $4::bigint[])`,
    [instanceIds, topics, payloads, timestamps],
  );
}

/**
 * Reads the current state of a machine instance directly from Postgres.
 */
export async function getMachineState(
  pool: Pool,
  workflowId: string,
): Promise<DurableStateSnapshot | null> {
  const { rows } = await pool.query(
    `SELECT state_value, context, status FROM machine_instances WHERE id = $1`,
    [workflowId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    value: row.state_value as StateValue,
    context: row.context as Record<string, unknown>,
    status:
      row.status === "done"
        ? "done"
        : row.status === "error"
          ? "error"
          : "running",
  };
}
