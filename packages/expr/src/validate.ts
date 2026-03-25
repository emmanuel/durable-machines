import type { Expr } from "./types.js";
import { EXPR_OPERATORS } from "./introspection.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ComplexityResult {
  operatorCount: number;
  maxDepth: number;
}

export interface ComplexityLimits {
  maxOperatorCount: number;
  maxDepth: number;
}

// ─── Error ──────────────────────────────────────────────────────────────────

export class ExprComplexityExceeded extends Error {
  operatorCount: number;
  maxDepth: number;
  limit: ComplexityLimits;

  constructor(result: ComplexityResult, limit: ComplexityLimits) {
    const parts: string[] = [];
    if (result.operatorCount > limit.maxOperatorCount) {
      parts.push(`operator count ${result.operatorCount} exceeds limit ${limit.maxOperatorCount}`);
    }
    if (result.maxDepth > limit.maxDepth) {
      parts.push(`depth ${result.maxDepth} exceeds limit ${limit.maxDepth}`);
    }
    super(`Expression complexity exceeded: ${parts.join("; ")}`);
    this.name = "ExprComplexityExceeded";
    this.operatorCount = result.operatorCount;
    this.maxDepth = result.maxDepth;
    this.limit = limit;
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Walk an expression tree and measure its complexity.
 * Completes the full walk before checking limits.
 * Throws ExprComplexityExceeded if either metric exceeds its limit.
 */
export function validateExprComplexity(
  expr: Expr,
  limits: ComplexityLimits,
): ComplexityResult {
  const result: ComplexityResult = { operatorCount: 0, maxDepth: 0 };
  walk(expr, 0, result);
  if (result.operatorCount > limits.maxOperatorCount || result.maxDepth > limits.maxDepth) {
    throw new ExprComplexityExceeded(result, limits);
  }
  return result;
}

function walk(node: unknown, depth: number, result: ComplexityResult): void {
  // Primitives contribute nothing
  if (node === null || node === undefined) return;
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") return;

  // Arrays: walk each element (operator arguments, not operators themselves)
  if (Array.isArray(node)) {
    for (const item of node) walk(item, depth, result);
    return;
  }

  // Objects: check if this is an operator
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  const isOp = Object.keys(obj).some(key => EXPR_OPERATORS.has(key));
  if (isOp) {
    result.operatorCount++;
    const opDepth = depth + 1;
    if (opDepth > result.maxDepth) result.maxDepth = opDepth;

    // Walk all values as sub-expressions
    for (const value of Object.values(obj)) {
      walk(value, opDepth, result);
    }
  }
  // Non-operator objects (e.g. {param: "x"}, {ref: "y"}) — walk values in case
  // they contain nested expressions (e.g. where predicates)
  else {
    for (const value of Object.values(obj)) {
      walk(value, depth, result);
    }
  }
}
