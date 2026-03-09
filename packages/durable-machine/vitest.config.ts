import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["tests/unit/pg-global-setup.ts"],
    projects: [
      "./vitest.unit.config.ts",
      "./vitest.integration.config.ts",
    ],
  },
});
