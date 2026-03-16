import type {
  Scope, Expr, ActionDef, ActionResult, GuardedBlock,
  AssignActionDef, EmitActionDef, RaiseActionDef, EnqueueActionsDef,
  BuiltinRegistry,
} from "./types.js";
import { evaluate } from "./evaluate.js";
import { applyTransforms } from "./transforms.js";

/**
 * Evaluate an action definition against a scope.
 * Returns an array of action results (enqueueActions may produce multiple).
 */
export function evaluateActions(
  action: ActionDef | GuardedBlock,
  scope: Scope,
  builtins: BuiltinRegistry,
): ActionResult[] {
  if (isGuardedBlock(action)) {
    const guardResult = evaluate(action.guard, scope, builtins);
    if (!guardResult) return [];
    return action.actions.flatMap((a) => evaluateActions(a, scope, builtins));
  }

  switch (action.type) {
    case "assign":
      return [evaluateAssign(action, scope, builtins)];
    case "emit":
      return [evaluateEmit(action, scope, builtins)];
    case "raise":
      return [evaluateRaise(action, scope, builtins)];
    case "enqueueActions":
      return evaluateEnqueue(action, scope, builtins);
    default:
      return [];
  }
}

function isGuardedBlock(action: ActionDef | GuardedBlock): action is GuardedBlock {
  return "guard" in action && "actions" in action && !("type" in action);
}

function evaluateAssign(action: AssignActionDef, scope: Scope, builtins: BuiltinRegistry): ActionResult {
  let evalScope = scope;
  if (action.let) {
    evalScope = applyLet(action.let, scope, builtins);
  }
  const newContext = applyTransforms(scope.context, action.transforms, evalScope, builtins);
  return { type: "assign", context: newContext };
}

function evaluateEmit(action: EmitActionDef, scope: Scope, builtins: BuiltinRegistry): ActionResult {
  const event = evaluateEventPayload(action.event, scope, builtins);
  return { type: "emit", event };
}

function evaluateRaise(action: RaiseActionDef, scope: Scope, builtins: BuiltinRegistry): ActionResult {
  const event = evaluateEventPayload(action.event, scope, builtins);
  const result: ActionResult & { type: "raise" } = { type: "raise", event };
  if (action.delay !== undefined) {
    result.delay = evaluate(action.delay, scope, builtins) as number;
  }
  if (action.id !== undefined) {
    result.id = action.id;
  }
  return result;
}

function evaluateEnqueue(action: EnqueueActionsDef, scope: Scope, builtins: BuiltinRegistry): ActionResult[] {
  let evalScope = scope;
  if (action.let) {
    evalScope = applyLet(action.let, scope, builtins);
  }

  const results: ActionResult[] = [];
  for (const entry of action.actions) {
    const entryResults = evaluateActions(entry, evalScope, builtins);
    for (const result of entryResults) {
      results.push(result);
      // Chain context: subsequent actions see updated context
      if (result.type === "assign") {
        evalScope = { ...evalScope, context: result.context };
      }
    }
  }
  return results;
}

function evaluateEventPayload(
  event: Record<string, Expr>,
  scope: Scope,
  builtins: BuiltinRegistry,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(event)) {
    result[key] = evaluate(val, scope, builtins);
  }
  return result;
}

function applyLet(
  letBindings: Record<string, Expr>,
  scope: Scope,
  builtins: BuiltinRegistry,
): Scope {
  const bindings = { ...scope.bindings };
  const innerScope: Scope = { ...scope, bindings };
  for (const [name, expr] of Object.entries(letBindings)) {
    bindings[name] = evaluate(expr, innerScope, builtins);
  }
  return innerScope;
}
