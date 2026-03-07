import type { AnyEventObject } from "xstate";

/** Scope available for expression resolution. */
export interface ExpressionScope {
  context: Record<string, unknown>;
  event?: AnyEventObject;
  input?: Record<string, unknown>;
}

/** Returns `true` if `value` is a `{ "$ref": string }` reference object. */
export function isRef(value: unknown): value is { $ref: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "$ref" in value &&
    typeof (value as any).$ref === "string"
  );
}

/**
 * Resolves a dot-path reference against a scope.
 *
 * Supported prefixes: `context.`, `event.`, `input.`.
 * Returns `undefined` for missing paths (does not throw).
 */
export function resolveRef(ref: string, scope: ExpressionScope): unknown {
  const dotIndex = ref.indexOf(".");
  const prefix = dotIndex === -1 ? ref : ref.slice(0, dotIndex);
  const path = dotIndex === -1 ? "" : ref.slice(dotIndex + 1);

  let root: unknown;
  switch (prefix) {
    case "context":
      root = scope.context;
      break;
    case "event":
      root = scope.event;
      break;
    case "input":
      root = scope.input;
      break;
    default:
      return undefined;
  }

  if (!path) return root;

  const segments = path.split(".");
  let current: any = root;
  for (const segment of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Recursively resolves `$ref` objects within a value.
 *
 * - `{ "$ref": "context.x" }` → resolved value
 * - Strings with `{{ }}` → template-interpolated string
 * - Arrays → each element resolved
 * - Plain objects → each value resolved (keys preserved)
 * - Primitives → returned as-is
 */
export function resolveExpressions(
  value: unknown,
  scope: ExpressionScope,
): unknown {
  if (isRef(value)) {
    return resolveRef(value.$ref, scope);
  }

  if (typeof value === "string" && value.includes("{{")) {
    return resolveTemplate(value, scope);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveExpressions(item, scope));
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = resolveExpressions(val, scope);
    }
    return result;
  }

  return value;
}

/**
 * Interpolates `{{ path }}` expressions in a template string.
 *
 * Each `{{ path }}` is resolved via `resolveRef`. Missing values
 * become empty strings.
 */
export function resolveTemplate(
  template: string,
  scope: ExpressionScope,
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, ref: string) => {
    const value = resolveRef(ref, scope);
    return value === undefined ? "" : String(value);
  });
}
