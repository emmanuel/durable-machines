import type { Scope, Transform, BuiltinRegistry, PathNavigator } from "./types.js";
import { resolveStep } from "./path.js";
import { evaluate } from "./evaluate.js";
import { matchesWhere } from "./where.js";

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

function isWhereStep(step: PathNavigator): step is { where: Record<string, unknown> } {
  return typeof step === "object" && step !== null && "where" in step;
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

  // Walk to the parent, handling `where` fan-outs along the way
  let parent: Record<string, unknown> = root;
  for (let i = 0; i < parentSteps.length; i++) {
    const step = parentSteps[i];

    // `where` navigator: fan-out — apply transform with remaining path to each match
    if (isWhereStep(step)) {
      const predicate = step.where;
      const remainingPath = [...path.slice(i + 1)];
      for (const [entryKey, entryValue] of Object.entries(parent)) {
        if (matchesWhere(entryValue, predicate, scope, evaluate, builtins)) {
          // Navigate into this entry and apply remaining path
          const subTransform: Transform = { ...transform, path: remainingPath };
          const entryObj = parent[entryKey];
          if (entryObj !== null && typeof entryObj === "object" && !Array.isArray(entryObj)) {
            applyOneTransform(entryObj as Record<string, unknown>, subTransform, scope, builtins);
          }
        }
      }
      // Fan-out handled — no further processing for this transform
      return;
    }

    const key = resolveStep(step, scope, builtins);
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

  // Handle `where` as the leaf step (unusual but handle gracefully — no-op)
  if (isWhereStep(leafStep)) return;

  // Resolve the leaf key
  const leafKey = resolveStep(leafStep, scope, builtins);
  if (leafKey === undefined) return;

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
