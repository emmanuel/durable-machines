import type { AnyStateMachine } from "xstate";
import { setup, assign, emit, raise, enqueueActions } from "xstate";
import type { MachineDefinition } from "./types.js";
import type { ImplementationRegistry } from "./registry.js";
import { validateDefinition } from "./validate-definition.js";
import { transformDefinition } from "./transform.js";
import { DurableMachineValidationError } from "../types.js";
import {
  compileGuard, compileAction, createScope,
  type BuiltinRegistry, type ActionResult,
} from "@durable-xstate/expr";

export interface ExprOptions {
  builtins?: BuiltinRegistry;
}

/**
 * Creates an XState machine from a JSON definition and an implementation registry.
 *
 * Steps:
 * 1. Validates the definition against the registry — throws on errors
 * 2. Transforms JSON → XState config
 * 3. Compiles named guard/action expressions from definition.guards / .actions
 * 4. Merges compiled impls with registry (no conflicts — validated in step 1)
 * 5. Calls `setup({ actors, guards, actions, delays }).createMachine(config)`
 *
 * The returned machine is compatible with `createDurableMachine()`.
 */
export function createMachineFromDefinition(
  definition: MachineDefinition,
  registry: ImplementationRegistry,
  exprOptions?: ExprOptions,
): AnyStateMachine {
  // 1. Validate
  const result = validateDefinition(definition, registry);
  if (!result.valid) {
    throw new DurableMachineValidationError(result.errors);
  }

  // 2. Transform JSON → XState config
  const config = transformDefinition(definition, registry);

  // 3. Compile expr guard/action definitions
  const builtins = exprOptions?.builtins;

  const compiledGuards: Record<string, (...args: any[]) => boolean> = {};
  if (definition.guards) {
    for (const [name, guardExpr] of Object.entries(definition.guards)) {
      const compiled = compileGuard(guardExpr, builtins);
      compiledGuards[name] = ({ context, event }: any, params: any) =>
        compiled(createScope({ context, event, params: params?.params ?? params ?? {} }));
    }
  }

  const compiledActions: Record<string, any> = {};
  if (definition.actions) {
    for (const [name, actionDef] of Object.entries(definition.actions)) {
      const compiled = compileAction(actionDef as any, builtins);
      compiledActions[name] = enqueueActions(({ context, event, enqueue }: any, params: any) => {
        const scope = createScope({ context, event, params: params?.params ?? params ?? {} });
        const results: ActionResult[] = compiled(scope);
        for (const r of results) {
          switch (r.type) {
            case "assign":
              enqueue(assign(() => r.context));
              break;
            case "emit":
              enqueue(emit(r.event as any));
              break;
            case "raise":
              enqueue(raise(r.event as any));
              break;
          }
        }
      });
    }
  }

  // 4. Merge: expr-compiled + registry (validated no conflicts)
  const mergedGuards = { ...compiledGuards, ...registry.guards };
  const mergedActions = { ...compiledActions, ...registry.actions };

  // 5. Create machine via setup()
  const machine = setup({
    actors: registry.actors as any,
    guards: mergedGuards as any,
    actions: mergedActions as any,
    delays: registry.delays as any,
  }).createMachine(config as any);

  return machine;
}
