import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

const envDir = "../..";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "");
  for (const [key, value] of Object.entries(env)) {
    process.env[key] ??= value;
  }

  return {
    envDir,
    test: {
      globalSetup: ["tests/unit/pg-global-setup.ts"],
      projects: [
        "./vitest.unit.config.ts",
        "./vitest.integration.config.ts",
      ],
    },
  };
});
