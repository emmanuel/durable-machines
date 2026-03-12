import { DBOS } from "@dbos-inc/dbos-sdk";
import { createDurableMachine, getVisualizationState } from "../../../src/dbos/index.js";
import { vizConformance } from "../../conformance/visualization.js";
import type { BackendFixture } from "../../fixtures/helpers.js";
import { DBOS_SYSTEM_DB_URL } from "../../test-db.js";

DBOS.setConfig({
  name: "visualization-test",
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
  getVisualizationState(machine, workflowId) {
    return getVisualizationState(machine, workflowId);
  },
};

vizConformance(dbosFixture);
