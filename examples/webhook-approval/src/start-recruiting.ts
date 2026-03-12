import { consoleChannel } from "@durable-xstate/durable-machine";
import { parseWorkerConfig, createDBOSWorkerContext } from "@durable-xstate/worker/dbos";
import { recruitingPipeline } from "./recruiting-pipeline.js";

const candidateName = process.argv[2] || "Jane Doe";
const role = process.argv[3] || "Senior Engineer";

const config = parseWorkerConfig();
const ctx = createDBOSWorkerContext(config, {
  machines: {
    recruiting: { machine: recruitingPipeline, options: { channels: [consoleChannel()] } },
  },
});

const handle = await ctx.machines.get("recruiting")!.start(`recruit-${Date.now()}`, {
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
