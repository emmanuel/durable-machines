/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "durable-machine-is-a-leaf",
      comment:
        "durable-machine must not import from worker or gateway — it is the shared core.",
      severity: "error",
      from: { path: "^packages/durable-machine/src" },
      to: {
        path: "^packages/(worker|gateway)/",
      },
    },
    {
      name: "worker-does-not-import-gateway",
      comment: "worker must not depend on gateway.",
      severity: "error",
      from: { path: "^packages/worker/src" },
      to: { path: "^packages/gateway/" },
    },
    {
      name: "gateway-does-not-import-worker",
      comment: "gateway production code must not depend on worker.",
      severity: "error",
      from: { path: "^packages/gateway/src" },
      to: { path: "^packages/worker/" },
    },
    {
      name: "pg-dbos-backend-isolation",
      comment:
        "pg/ and dbos/ backend directories must not cross-import within a package.",
      severity: "error",
      from: { path: "^packages/[^/]+/src/pg/" },
      to: { path: "^packages/[^/]+/src/dbos/" },
    },
    {
      name: "dbos-pg-backend-isolation",
      comment:
        "dbos/ and pg/ backend directories must not cross-import within a package.",
      severity: "error",
      from: { path: "^packages/[^/]+/src/dbos/" },
      to: { path: "^packages/[^/]+/src/pg/" },
    },
    {
      name: "no-circular",
      comment: "No circular dependencies allowed.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-test-imports-in-production",
      comment: "Production code (src/) must not import from tests/.",
      severity: "error",
      from: { path: "^packages/[^/]+/src/" },
      to: { path: "^packages/[^/]+/tests/" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
