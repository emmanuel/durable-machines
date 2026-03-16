import type { Pool } from "pg";
import type { AnyEventObject } from "xstate";
import type { DurableStateSnapshot } from "../types.js";
import type { StateValue } from "xstate";
import {
  Q_SEND_MACHINE_EVENT,
  Q_SEND_MACHINE_EVENT_BATCH,
  Q_GET_MACHINE_STATE,
} from "./queries.js";

/**
 * Sends an event to a machine instance via direct SQL insert into `event_log`.
 * The NOTIFY trigger will alert the listener for event-driven processing.
 */
export async function sendMachineEvent(
  pool: Pool,
  workflowId: string,
  event: AnyEventObject,
  idempotencyKey?: string,
): Promise<void> {
  await pool.query({
    ...Q_SEND_MACHINE_EVENT,
    values: [workflowId, JSON.stringify(event), idempotencyKey ?? null, Date.now()],
  });
}

/**
 * Sends a batch of events to machine instances via a single multi-row INSERT.
 * The NOTIFY trigger fires per-row automatically.
 */
export async function sendMachineEventBatch(
  pool: Pool,
  events: Array<{ workflowId: string; event: AnyEventObject; idempotencyKey?: string }>,
): Promise<void> {
  if (events.length === 0) return;

  const now = Date.now();
  const instanceIds: string[] = [];
  const topics: string[] = [];
  const payloads: string[] = [];
  const idempotencyKeys: (string | null)[] = [];
  const timestamps: number[] = [];

  for (const { workflowId, event, idempotencyKey } of events) {
    instanceIds.push(workflowId);
    topics.push("event");
    payloads.push(JSON.stringify(event));
    idempotencyKeys.push(idempotencyKey ?? null);
    timestamps.push(now);
  }

  await pool.query({
    ...Q_SEND_MACHINE_EVENT_BATCH,
    values: [instanceIds, topics, payloads, idempotencyKeys, timestamps],
  });
}

/**
 * Reads the current state of a machine instance directly from Postgres.
 */
export async function getMachineState(
  pool: Pool,
  workflowId: string,
): Promise<DurableStateSnapshot | null> {
  const { rows } = await pool.query({
    ...Q_GET_MACHINE_STATE,
    values: [workflowId],
  });
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
