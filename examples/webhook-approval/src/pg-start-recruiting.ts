import { consoleChannel } from "@durable-machines/machine";
import { parsePgConfig } from "@durable-machines/machine/pg";
import { createPgWorkerContext } from "@durable-machines/worker/pg";
import { recruitingPipeline } from "./recruiting-pipeline.js";

const candidateName = process.argv[2] || "Jane Doe";
const role = process.argv[3] || "Senior Engineer";

const pg = parsePgConfig();
const ctx = createPgWorkerContext(pg);

const dm = ctx.register(recruitingPipeline, { channels: [consoleChannel()], enableAnalytics: true });

const handle = await dm.start(`recruit-${Date.now()}`, {
  candidateName,
  role,
});

console.log(`Started recruiting pipeline: ${handle.workflowId}`);
console.log(`Candidate: ${candidateName}, Role: ${role}`);
console.log("");
console.log("Step 1 — Screen the candidate:");
console.log(`  curl -X POST http://localhost:3000/webhooks/generic \\`);
console.log(`    -H "Content-Type: application/json" \\`);
console.log(`    -d '{"workflowId": "${handle.workflowId}", "event": "SCREEN"}'`);
console.log("");
console.log("Step 2 — Submit interview feedback:");
console.log(`  curl -X POST http://localhost:3000/webhooks/generic \\`);
console.log(`    -H "Content-Type: application/json" \\`);
console.log(`    -d '{"workflowId": "${handle.workflowId}", "event": "TECH_FEEDBACK", "data": {"score": 8}}'`);
console.log("");
console.log(`  curl -X POST http://localhost:3000/webhooks/generic \\`);
console.log(`    -H "Content-Type: application/json" \\`);
console.log(`    -d '{"workflowId": "${handle.workflowId}", "event": "CULTURE_FEEDBACK", "data": {"score": 9}}'`);
console.log("");
console.log("Step 3 — Accept or decline the offer:");
console.log(`  curl -X POST http://localhost:3000/webhooks/generic \\`);
console.log(`    -H "Content-Type: application/json" \\`);
console.log(`    -d '{"workflowId": "${handle.workflowId}", "event": "ACCEPT"}'`);

// Close pool so the process exits cleanly
await ctx.pool.end();
