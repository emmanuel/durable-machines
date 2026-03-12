import { consoleChannel } from "@durable-xstate/durable-machine";
import { parsePgConfig } from "@durable-xstate/durable-machine/pg";
import { createPgWorkerContext } from "@durable-xstate/worker/pg";
import { approvalMachine } from "./machine.js";

const requestId = process.argv[2] || `req-${Date.now()}`;

const pg = parsePgConfig();
const ctx = createPgWorkerContext(pg);

const dm = ctx.register(approvalMachine, { channels: [consoleChannel()], enableAnalytics: true });

const handle = await dm.start(`approval-${requestId}`, {
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

// Close pool so the process exits cleanly
await ctx.pool.end();
