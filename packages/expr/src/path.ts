import type { Path, PathNavigator, Scope } from "./types.js";

/**
 * Navigate a path against the scope and return the value at the path.
 * Returns `undefined` for missing or non-navigable paths.
 */
export function selectPath(path: Path, scope: Scope): unknown {
  if (path.length === 0) return undefined;

  const [root, ...rest] = path;

  // Root must be a string
  if (typeof root !== "string") return undefined;

  // Resolve the root value
  let current: unknown;
  if (root === "context") {
    current = scope.context;
  } else if (root === "event") {
    current = scope.event;
  } else if (root === "params") {
    current = scope.params;
  } else if (root in scope.bindings) {
    current = scope.bindings[root];
  } else {
    return undefined;
  }

  // Navigate the remaining steps
  for (const step of rest) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;

    const key = resolveStep(step, scope);
    if (key === undefined) return undefined;

    current = (current as Record<string, unknown>)[String(key)];
  }

  return current;
}

/**
 * Resolve a PathNavigator step to a concrete key string.
 */
function resolveStep(step: PathNavigator, scope: Scope): string | undefined {
  if (typeof step === "string") {
    return step;
  }
  if ("param" in step) {
    const paramVal = scope.params[step.param];
    return paramVal !== undefined ? String(paramVal) : undefined;
  }
  if ("ref" in step) {
    const refVal = scope.bindings[step.ref];
    return refVal !== undefined ? String(refVal) : undefined;
  }
  // Other navigators (where, all, first, last) are handled in later tasks
  return undefined;
}
