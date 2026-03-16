export { evaluate } from "./evaluate.js";
export { defaultBuiltins } from "./builtins.js";
export { createScope } from "./types.js";
export type {
  Scope, Expr, Path, PathNavigator, Transform,
  ActionDef, AssignActionDef, EmitActionDef, RaiseActionDef,
  EnqueueActionsDef, GuardedBlock, ActionResult,
  BuiltinFn, BuiltinRegistry,
} from "./types.js";
