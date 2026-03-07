import type { AnyStateMachine } from "xstate";
import { setup } from "xstate";
import type { MachineDefinition } from "./types.js";
import type { ImplementationRegistry } from "./registry.js";
import { validateDefinition } from "./validate-definition.js";
import { transformDefinition } from "./transform.js";
import { DurableMachineValidationError } from "../types.js";

/**
 * Creates an XState machine from a JSON definition and an implementation registry.
 *
 * Steps:
 * 1. Validates the definition against the registry — throws on errors
 * 2. Transforms JSON → XState config
 * 3. Calls `setup({ actors, guards, actions, delays }).createMachine(config)`
 *
 * The returned machine is compatible with `createDurableMachine()`.
 */
export function createMachineFromDefinition(
  definition: MachineDefinition,
  registry: ImplementationRegistry,
): AnyStateMachine {
  // 1. Validate
  const result = validateDefinition(definition, registry);
  if (!result.valid) {
    throw new DurableMachineValidationError(result.errors);
  }

  // 2. Transform JSON → XState config
  const config = transformDefinition(definition, registry);

  // 3. Create machine via setup()
  const machine = setup({
    actors: registry.actors as any,
    guards: registry.guards as any,
    actions: registry.actions as any,
    delays: registry.delays as any,
  }).createMachine(config as any);

  return machine;
}
