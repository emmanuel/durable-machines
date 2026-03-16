// selectPath and resolveStep live in evaluate.ts to avoid a circular dependency:
// evaluate → path → where → evaluate.  By co-locating them in evaluate.ts the
// chain becomes: evaluate → where (leaf).  path.ts re-exports for public API
// convenience.
export { selectPath, resolveStep } from "./evaluate.js";
