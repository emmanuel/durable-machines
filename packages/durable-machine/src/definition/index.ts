// Types
export type {
  MachineDefinition,
  StateDefinition,
  TransitionDefinition,
  ActionDefinition,
  InvokeDefinition,
} from "./types.js";

export type { ImplementationRegistry } from "./registry.js";
export type { DefinitionValidationResult } from "./validate-definition.js";

// Registry
export { createImplementationRegistry } from "./registry.js";

// Validation
export { validateDefinition } from "./validate-definition.js";

// Expressions
export { isRef, resolveRef, resolveExpressions, resolveTemplate } from "./expressions.js";

// Transform
export { transformDefinition } from "./transform.js";

// Machine creation
export { createMachineFromDefinition } from "./create-machine.js";
export type { ExprOptions } from "./create-machine.js";
