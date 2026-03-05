import { consoleChannel } from "@xstate-dbos/durable-state-machine";
import { parseWorkerConfig, createWorkerContext, startWorker } from "@xstate-dbos/worker";
import { approvalMachine } from "./machine.js";

const config = parseWorkerConfig();
const ctx = await createWorkerContext(config, {
  machines: {
    approvals: { machine: approvalMachine, options: { channels: [consoleChannel()] } },
  },
});
startWorker(ctx);
