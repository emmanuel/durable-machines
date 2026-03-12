import { DBOS } from "@dbos-inc/dbos-sdk";
import { createDurableMachine } from "../../../src/dbos/index.js";
import { promptConformance } from "../../conformance/prompt-channels.js";
import type { BackendFixture } from "../../fixtures/helpers.js";
import { DBOS_SYSTEM_DB_URL } from "../../test-db.js";

DBOS.setConfig({
  name: "prompt-test",
  systemDatabaseUrl: DBOS_SYSTEM_DB_URL,
});

const dbosFixture: BackendFixture = {
  name: "dbos",
  async setup() {
    await DBOS.launch();
  },
  async teardown() {
    const pending = await DBOS.listWorkflows({ status: "PENDING" as any });
    await Promise.all(pending.map((w) => DBOS.cancelWorkflow(w.workflowID)));
    await DBOS.shutdown({ deregister: true });
  },
  createMachine(machine, options) {
    return createDurableMachine(machine, options);
  },
};

promptConformance(dbosFixture);
