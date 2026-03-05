import { DBOS } from "@dbos-inc/dbos-sdk";
import { createDurableMachine, consoleChannel } from "xstate-dbos";
import { approvalMachine } from "./machine.js";

async function main() {
  const requestId = process.argv[2] || `req-${Date.now()}`;

  const approvals = createDurableMachine(approvalMachine, {
    channels: [consoleChannel()],
  });

  await DBOS.launch();

  const handle = await approvals.start(`approval-${requestId}`, {
    requestId,
    requester: "alice@example.com",
    description: "Access to production database",
  });

  console.log(`Started approval workflow: ${handle.workflowId}`);
  console.log("Send approval via generic webhook:");
  console.log(`  curl -X POST http://localhost:3000/webhooks/generic \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(
    `    -d '{"workflowId": "${handle.workflowId}", "event": "APPROVE"}'`,
  );

  await DBOS.shutdown();
}

main().catch(console.error);
