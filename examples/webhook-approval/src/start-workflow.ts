import { consoleChannel } from "@durable-xstate/durable-machine";
import { parseWorkerConfig, createDBOSWorkerContext } from "@durable-xstate/worker/dbos";
import { approvalMachine } from "./machine.js";

const requestId = process.argv[2] || `req-${Date.now()}`;

const config = parseWorkerConfig();
const ctx = createDBOSWorkerContext(config, {
  machines: {
    approvals: { machine: approvalMachine, options: { channels: [consoleChannel()] } },
  },
});

const handle = await ctx.machines.get("approvals")!.start(`approval-${requestId}`, {
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
