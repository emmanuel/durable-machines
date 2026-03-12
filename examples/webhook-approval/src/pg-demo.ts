/**
 * One-shot demo: starts Postgres (docker compose), worker, gateway,
 * and creates a recruiting-pipeline instance — all in one process.
 *
 * Usage:
 *   pnpm --filter @durable-xstate/example-webhook-approval pg:demo
 */

import { execSync, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");

// ── 1. Ensure Postgres is up ────────────────────────────────────
console.log("▶ Starting Postgres …");
execSync("docker compose up -d --wait", { cwd: root, stdio: "inherit" });

// ── 2. Start worker (background) ────────────────────────────────
console.log("\n▶ Starting worker …");
const worker = fork(
  path.resolve(fileURLToPath(import.meta.url), "../pg-worker.ts"),
  [],
  { execArgv: ["--import", "tsx"], stdio: "inherit" },
);

// Give the worker a moment to run migrations / start polling
await new Promise((r) => setTimeout(r, 2000));

// ── 3. Start gateway (background) ───────────────────────────────
console.log("\n▶ Starting gateway …");
const gateway = fork(
  path.resolve(fileURLToPath(import.meta.url), "../pg-gateway.ts"),
  [],
  { execArgv: ["--import", "tsx"], stdio: "inherit" },
);

// Wait for gateway to bind
await new Promise((r) => setTimeout(r, 2000));

// ── 4. Create a recruiting-pipeline instance ────────────────────
console.log("\n▶ Starting recruiting pipeline …");
const starter = fork(
  path.resolve(fileURLToPath(import.meta.url), "../pg-start-recruiting.ts"),
  ["Jane Doe", "Senior Engineer"],
  { execArgv: ["--import", "tsx"], stdio: "inherit" },
);

await new Promise<void>((resolve) => starter.on("exit", () => resolve()));

console.log("\n✅ Dashboard: http://localhost:3000/dashboard");
console.log("Press Ctrl+C to stop.\n");

// ── Cleanup on exit ─────────────────────────────────────────────
function cleanup() {
  worker.kill();
  gateway.kill();
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
