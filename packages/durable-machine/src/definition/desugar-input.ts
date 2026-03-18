import {
  compile, isExprOperator, defaultBuiltins, createScope,
  type BuiltinRegistry,
} from "@durable-machines/expr";

/**
 * Recursively converts legacy `$ref`/`{{ }}` syntax to expr AST.
 *
 * - `{ $ref: "context.x.y" }` → `{ select: ["context", "x", "y"] }`
 * - `"Hello {{ context.name }}"` → `{ fn: ["str", "Hello ", { select: ["context", "name"] }] }`
 * - Plain objects (not expr, not $ref) → `{ object: { key: desugar(val), ... } }`
 * - Expr operator objects → pass-through
 * - Primitives, arrays → pass-through
 */
export function desugarInput(value: unknown): unknown {
  // Primitives
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean" || typeof value === "number") return value;

  // Template strings
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    return desugarTemplate(value);
  }

  // Arrays pass through
  if (Array.isArray(value)) return value;

  // Objects
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // $ref → select
    if ("$ref" in obj && typeof obj.$ref === "string") {
      const segments = (obj.$ref as string).split(".");
      return { select: segments };
    }

    // Already an expr operator → pass-through
    if (isExprOperator(obj)) return obj;

    // Plain object → wrap in { object: { ... } } so nested exprs compile
    const wrapped: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      wrapped[key] = desugarInput(val);
    }
    return { object: wrapped };
  }

  return value;
}

/**
 * Convert a `{{ }}` template string into an expr `{ fn: ["str", ...] }` call.
 */
function desugarTemplate(template: string): unknown {
  const parts: unknown[] = [];
  let lastIndex = 0;
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(template)) !== null) {
    // Static text before this match
    if (match.index > lastIndex) {
      parts.push(template.slice(lastIndex, match.index));
    }
    // The referenced path
    const segments = match[1].split(".");
    parts.push({ select: segments });
    lastIndex = re.lastIndex;
  }

  // Trailing static text
  if (lastIndex < template.length) {
    parts.push(template.slice(lastIndex));
  }

  // If only one part and it's a select, return it directly
  if (parts.length === 1 && typeof parts[0] === "object") {
    return parts[0];
  }

  return { fn: ["str", ...parts] };
}

/**
 * Desugar and compile an input value into an XState-compatible input mapper.
 *
 * Returns a function `({ context, event }) => resolved` suitable for use
 * as `invoke.input` in an XState config.
 */
export function compileInput(
  input: unknown,
  builtins?: BuiltinRegistry,
): (args: { context: Record<string, unknown>; event?: Record<string, unknown> }) => unknown {
  const desugared = desugarInput(input);
  const compiled = compile(desugared, builtins ?? defaultBuiltins);
  return ({ context, event }) =>
    compiled(createScope({ context, event: event ?? {} }));
}
