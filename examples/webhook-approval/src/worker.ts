import { consoleChannel } from "@durable-xstate/durable-machine";
import { parseDBOSWorkerConfig, createDBOSWorkerContext, startDBOSWorker } from "@durable-xstate/worker/dbos";
import { approvalMachine } from "./machine.js";

const config = parseDBOSWorkerConfig();
const ctx = await createDBOSWorkerContext(config, {
  machines: {
    approvals: { machine: approvalMachine, options: { channels: [consoleChannel()] } },
  },
});
startDBOSWorker(ctx);
