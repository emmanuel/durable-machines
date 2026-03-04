import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "integration",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
