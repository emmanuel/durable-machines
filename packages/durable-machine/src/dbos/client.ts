import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import type { AnyEventObject } from "xstate";
import type { DurableStateSnapshot } from "../types.js";

/**
 * Send an XState event to a running durable machine from an external process.
 *
 * Uses `DBOSClient` — only needs a Postgres connection, no DBOS runtime.
 * Ideal for webhook gateways, API handlers, or CLI tools.
 *
 * ```ts
 * const client = await DBOSClient.create({ systemDatabaseUrl: "..." });
 * await sendMachineEvent(client, "order-123", { type: "PAY" });
 * await client.destroy();
 * ```
 */
export async function sendMachineEvent(
  client: DBOSClient,
  workflowId: string,
  event: AnyEventObject,
): Promise<void> {
  await client.send(workflowId, event, "xstate.event");
}

/**
 * Read the current state of a durable machine from an external process.
 *
 * Returns null if the state hasn't been published yet.
 *
 * @param client - A `DBOSClient` instance (needs only a Postgres connection)
 * @param workflowId - The workflow ID of the durable machine instance
 * @returns The current {@link DurableStateSnapshot}, or `null` if not yet published
 */
export async function getMachineState(
  client: DBOSClient,
  workflowId: string,
): Promise<DurableStateSnapshot | null> {
  return client.getEvent<DurableStateSnapshot>(workflowId, "xstate.state", 0.1);
}
