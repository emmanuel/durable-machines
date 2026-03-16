export { evaluate } from "./evaluate.js";
export { evaluateActions } from "./actions.js";
export { selectPath } from "./path.js";
export { applyTransforms } from "./transforms.js";
export { defaultBuiltins, createBuiltinRegistry } from "./builtins.js";
export { createScope } from "./types.js";
export type {
  Scope, Expr, Path, PathNavigator, Transform,
  ActionDef, AssignActionDef, EmitActionDef, RaiseActionDef,
  EnqueueActionsDef, GuardedBlock, ActionResult,
  BuiltinFn, BuiltinRegistry,
} from "./types.js";
