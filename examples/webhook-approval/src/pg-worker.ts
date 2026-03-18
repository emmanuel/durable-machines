import { consoleChannel } from "@durable-machines/machine";
import { parsePgConfig } from "@durable-machines/machine/pg";
import { parseWorkerConfig } from "@durable-machines/worker";
import { startPgWorker } from "@durable-machines/worker/pg";
import { approvalMachine } from "./machine.js";
import { recruitingPipeline } from "./recruiting-pipeline.js";

const pg = parsePgConfig();
const worker = parseWorkerConfig();

await startPgWorker({
  pg,
  worker,
  machines: {
    approvals: { machine: approvalMachine, options: { channels: [consoleChannel()], enableAnalytics: true } },
    recruiting: { machine: recruitingPipeline, options: { channels: [consoleChannel()], enableAnalytics: true } },
  },
});
