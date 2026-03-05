import { DBOS } from "@dbos-inc/dbos-sdk";
import { createDurableMachine, consoleChannel, gracefulShutdown } from "xstate-dbos";
import { approvalMachine } from "./machine.js";

const approvals = createDurableMachine(approvalMachine, {
  channels: [consoleChannel()],
});

// Export for use by start-workflow
export { approvals };

async function main() {
  await DBOS.launch();
  console.log("Worker running. Waiting for approval workflows...");

  gracefulShutdown({
    onShutdown: (reason) => console.log(`Shutting down (${reason})...`),
  });
}

main().catch(console.error);
