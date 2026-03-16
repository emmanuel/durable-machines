import type { Scope, Transform, BuiltinRegistry } from "./types.js";
import { resolveStep } from "./path.js";
import { evaluate } from "./evaluate.js";

/**
 * Apply a list of transforms to a deep-cloned context.
 * Returns the mutated clone; the original is untouched.
 */
export function applyTransforms(
  context: Record<string, unknown>,
  transforms: Transform[],
  scope: Scope,
  builtins?: BuiltinRegistry,
): Record<string, unknown> {
  const clone = structuredClone(context);
  for (const t of transforms) {
    applyOneTransform(clone, t, scope, builtins);
  }
  return clone;
}

function applyOneTransform(
  root: Record<string, unknown>,
  transform: Transform,
  scope: Scope,
  builtins?: BuiltinRegistry,
): void {
  const { path } = transform;
  if (path.length === 0) return;

  // Navigate to the parent object (all steps except the last)
  const parentSteps = path.slice(0, -1);
  const leafStep = path[path.length - 1];

  // Resolve the leaf key
  const leafKey = resolveStep(leafStep, scope);
  if (leafKey === undefined) return;

  // Walk to the parent, creating intermediate objects as needed for `set`
  let parent: Record<string, unknown> = root;
  for (let i = 0; i < parentSteps.length; i++) {
    const step = parentSteps[i];
    const key = resolveStep(step, scope);
    if (key === undefined) return;

    const next = parent[key];
    if (next === null || next === undefined) {
      // Only create intermediates for set operations
      if ("set" in transform) {
        parent[key] = {};
        parent = parent[key] as Record<string, unknown>;
      } else {
        return;
      }
    } else if (typeof next !== "object") {
      return;
    } else {
      parent = next as Record<string, unknown>;
    }
  }

  // Apply the operation
  if ("set" in transform) {
    parent[leafKey] = evaluate(transform.set, scope, builtins);
  } else if ("append" in transform) {
    const value = evaluate(transform.append, scope, builtins);
    const existing = parent[leafKey];
    if (Array.isArray(existing)) {
      existing.push(value);
    }
  } else if (transform.remove === true) {
    delete parent[leafKey];
  }
}
