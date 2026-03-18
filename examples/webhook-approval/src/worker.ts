import { consoleChannel } from "@durable-machines/machine";
import { parseWorkerConfig, createDBOSWorkerContext, startDBOSWorker } from "@durable-machines/worker/dbos";
import { approvalMachine } from "./machine.js";
import { recruitingPipeline } from "./recruiting-pipeline.js";

const config = parseWorkerConfig();
const ctx = createDBOSWorkerContext(config, {
  machines: {
    approvals: { machine: approvalMachine, options: { channels: [consoleChannel()] } },
    recruiting: { machine: recruitingPipeline, options: { channels: [consoleChannel()] } },
  },
});
startDBOSWorker(ctx);
