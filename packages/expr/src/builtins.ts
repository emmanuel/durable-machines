import type { BuiltinRegistry } from "./types.js";
import { randomUUID } from "node:crypto";

export const defaultBuiltins: BuiltinRegistry = {
  uuid: () => randomUUID(),
  now: () => Date.now(),
};

export function createBuiltinRegistry(custom: BuiltinRegistry): BuiltinRegistry {
  return { ...defaultBuiltins, ...custom };
}
