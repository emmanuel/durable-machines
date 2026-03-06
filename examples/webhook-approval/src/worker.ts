import { consoleChannel } from "@xstate-durable/durable-machine";
import { parseWorkerConfig, createWorkerContext, startWorker } from "@xstate-durable/worker";
import { approvalMachine } from "./machine.js";

const config = parseWorkerConfig();
const ctx = await createWorkerContext(config, {
  machines: {
    approvals: { machine: approvalMachine, options: { channels: [consoleChannel()] } },
  },
});
startWorker(ctx);
