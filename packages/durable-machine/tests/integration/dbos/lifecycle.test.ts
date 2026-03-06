import { DBOS } from "@dbos-inc/dbos-sdk";
import { createDurableMachine } from "../../../src/dbos/index.js";
import { lifecycleConformance } from "../../conformance/lifecycle.js";
import type { BackendFixture } from "../../fixtures/helpers.js";

const SYSTEM_DB_URL =
  process.env.DBOS_SYSTEM_DATABASE_URL ??
  "postgresql://xstate_dbos:xstate_dbos@localhost:5442/xstate_dbos_test";

DBOS.setConfig({
  name: "lifecycle-test",
  systemDatabaseUrl: SYSTEM_DB_URL,
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

lifecycleConformance(dbosFixture);
