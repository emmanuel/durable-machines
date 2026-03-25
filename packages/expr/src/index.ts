export { evaluate } from "./evaluate.js";
export { evaluateActions } from "./actions.js";
export { selectPath } from "./path.js";
export { applyTransforms } from "./transforms.js";
export { defaultBuiltins, createBuiltinRegistry } from "./builtins.js";
export { createScope, deductStep, StepBudgetExceeded } from "./types.js";
export { compile } from "./compile.js";
export { parseDollarPath, parseParamSugar, parseRefSugar } from "./desugar.js";
export { compileGuard, compileAction } from "./compile-actions.js";
export { isExprOperator } from "./introspection.js";
export {
  validateExprComplexity, ExprComplexityExceeded,
  checkContextSize, ContextSizeLimitExceeded,
} from "./validate.js";
export type {
  Scope, Expr, Path, PathNavigator, Transform,
  ActionDef, AssignActionDef, EmitActionDef, RaiseActionDef,
  EnqueueActionsDef, GuardedBlock, ActionResult,
  BuiltinFn, BuiltinRegistry, CompiledExpr, CompiledGuard, CompiledAction,
} from "./types.js";
export type { ComplexityResult, ComplexityLimits } from "./validate.js";
