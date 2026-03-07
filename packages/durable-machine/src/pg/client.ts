import type { Pool } from "pg";
import type { AnyEventObject } from "xstate";
import type { DurableStateSnapshot } from "../types.js";
import type { StateValue } from "xstate";

/**
 * Sends an event to a machine instance via direct SQL insert into `machine_messages`.
 * The NOTIFY trigger will alert the listener for event-driven processing.
 */
export async function sendMachineEvent(
  pool: Pool,
  workflowId: string,
  event: AnyEventObject,
): Promise<void> {
  await pool.query(
    `INSERT INTO machine_messages (instance_id, topic, payload, created_at)
     VALUES ($1, 'event', $2, $3)`,
    [workflowId, JSON.stringify(event), Date.now()],
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
