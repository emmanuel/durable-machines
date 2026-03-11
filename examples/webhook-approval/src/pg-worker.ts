import { consoleChannel } from "@durable-xstate/durable-machine";
import { parsePgConfig } from "@durable-xstate/durable-machine/pg";
import { parseWorkerConfig } from "@durable-xstate/worker";
import { startPgWorker } from "@durable-xstate/worker/pg";
import { approvalMachine } from "./machine.js";

const pg = parsePgConfig();
const worker = parseWorkerConfig();

await startPgWorker({
  pg,
  worker,
  machines: {
    approvals: { machine: approvalMachine, options: { channels: [consoleChannel()], enableTransitionStream: true } },
  },
});
