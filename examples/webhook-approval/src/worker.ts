import { DBOS } from "@dbos-inc/dbos-sdk";
import { createDurableMachine, consoleChannel } from "xstate-dbos";
import { approvalMachine } from "./machine.js";

const approvals = createDurableMachine(approvalMachine, {
  channels: [consoleChannel()],
});

// Export for use by start-workflow
export { approvals };

async function main() {
  await DBOS.launch();
  console.log("Worker running. Waiting for approval workflows...");

  // Keep process alive
  process.on("SIGINT", async () => {
    await DBOS.shutdown();
    process.exit(0);
  });
}

main().catch(console.error);
