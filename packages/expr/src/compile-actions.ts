import type {
  Scope, Expr, ActionDef, ActionResult, GuardedBlock,
  AssignActionDef, EmitActionDef, RaiseActionDef, EnqueueActionsDef,
  BuiltinRegistry, CompiledGuard, CompiledAction,
} from "./types.js";
import { compile } from "./compile.js";
import { applyTransforms } from "./transforms.js";

/**
 * Compile a guard expression into a boolean-returning closure.
 */
export function compileGuard(expr: Expr, builtins?: BuiltinRegistry): CompiledGuard {
  const fn = compile(expr, builtins);
  return (scope: Scope) => Boolean(fn(scope));
}

/**
 * Compile an action definition into a closure returning ActionResult[].
 *
 * Pre-compiles let bindings, guard conditions, and event payloads.
 * Delegates transform application to `applyTransforms` (interpreter).
 */
export function compileAction(actionDef: ActionDef, builtins?: BuiltinRegistry): CompiledAction {
  switch (actionDef.type) {
    case "assign": return compileAssign(actionDef, builtins);
    case "emit": return compileEmit(actionDef, builtins);
    case "raise": return compileRaise(actionDef, builtins);
    case "enqueueActions": return compileEnqueue(actionDef, builtins);
  }
}

function compileAssign(action: AssignActionDef, builtins?: BuiltinRegistry): CompiledAction {
  const compiledLet = action.let ? compileLetBindings(action.let, builtins) : null;
  return (scope) => {
    const evalScope = compiledLet ? applyCompiledLet(compiledLet, scope) : scope;
    const context = applyTransforms(scope.context, action.transforms, evalScope, builtins);
    return [{ type: "assign", context }];
  };
}

function compileEmit(action: EmitActionDef, builtins?: BuiltinRegistry): CompiledAction {
  const compiledEvent = compileEventPayload(action.event, builtins);
  return (scope) => [{ type: "emit", event: compiledEvent(scope) }];
}

function compileRaise(action: RaiseActionDef, builtins?: BuiltinRegistry): CompiledAction {
  const compiledEvent = compileEventPayload(action.event, builtins);
  const compiledDelay = action.delay !== undefined ? compile(action.delay, builtins) : null;
  const id = action.id;
  return (scope) => {
    const result: ActionResult & { type: "raise" } = { type: "raise", event: compiledEvent(scope) };
    if (compiledDelay) result.delay = compiledDelay(scope) as number;
    if (id !== undefined) result.id = id;
    return [result];
  };
}

function compileEnqueue(action: EnqueueActionsDef, builtins?: BuiltinRegistry): CompiledAction {
  const compiledLet = action.let ? compileLetBindings(action.let, builtins) : null;
  const compiledEntries = action.actions.map(entry => compileEntry(entry, builtins));

  return (scope) => {
    let evalScope = compiledLet ? applyCompiledLet(compiledLet, scope) : scope;
    const results: ActionResult[] = [];
    for (const entryFn of compiledEntries) {
      const entryResults = entryFn(evalScope);
      for (const result of entryResults) {
        results.push(result);
        if (result.type === "assign") {
          evalScope = { ...evalScope, context: result.context };
        }
      }
    }
    return results;
  };
}

function compileEntry(entry: ActionDef | GuardedBlock, builtins?: BuiltinRegistry): CompiledAction {
  if ("guard" in entry && "actions" in entry && !("type" in entry)) {
    const guardFn = compile((entry as GuardedBlock).guard, builtins);
    const innerFns = (entry as GuardedBlock).actions.map(a => compileAction(a, builtins));
    return (scope) => {
      if (!guardFn(scope)) return [];
      return innerFns.flatMap(fn => fn(scope));
    };
  }
  return compileAction(entry as ActionDef, builtins);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type CompiledLetBinding = Array<{ name: string; fn: (scope: Scope) => unknown }>;

function compileLetBindings(bindings: Record<string, Expr>, builtins?: BuiltinRegistry): CompiledLetBinding {
  return Object.entries(bindings).map(([name, expr]) => ({ name, fn: compile(expr, builtins) }));
}

function applyCompiledLet(compiledLet: CompiledLetBinding, scope: Scope): Scope {
  const bindings = { ...scope.bindings };
  const inner: Scope = { ...scope, bindings };
  for (const { name, fn } of compiledLet) {
    bindings[name] = fn(inner);
  }
  return inner;
}

function compileEventPayload(
  event: Record<string, Expr>,
  builtins?: BuiltinRegistry,
): (scope: Scope) => Record<string, unknown> {
  const fields = Object.entries(event).map(([key, expr]) => ({ key, fn: compile(expr, builtins) }));
  return (scope) => {
    const result: Record<string, unknown> = {};
    for (const { key, fn } of fields) {
      result[key] = fn(scope);
    }
    return result;
  };
}
