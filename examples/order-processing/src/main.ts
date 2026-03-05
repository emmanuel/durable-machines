import { DBOS } from "@dbos-inc/dbos-sdk";
import { createDurableMachine } from "@xstate-dbos/durable-state-machine";
import { orderMachine } from "./machine.js";
import { logChannel } from "./channel.js";

// Register the durable machine before DBOS.launch().
const orders = createDurableMachine(orderMachine, {
  channels: [logChannel()],
});

async function main() {
  await DBOS.launch();

  // Start a new order workflow
  const handle = await orders.start("order-001", {
    orderId: "ORD-123",
    total: 99.99,
  });

  // Check current state
  const state = await handle.getState();
  console.log("Current state:", state?.value);

  // Approve the order (resolves the pending prompt)
  await handle.send({ type: "APPROVE" });

  // Wait for the workflow to reach a final state
  const result = await handle.getResult();
  console.log("Final context:", result);

  await DBOS.shutdown();
}

main().catch(console.error);
