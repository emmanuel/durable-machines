import type { BuiltinRegistry } from "./types.js";
import { randomUUID } from "node:crypto";

export const defaultBuiltins: BuiltinRegistry = {
  uuid: () => randomUUID(),
  now: () => Date.now(),
  iso8601Duration: (startISO: unknown, endISO: unknown) => {
    const ms = new Date(endISO as string).getTime() - new Date(startISO as string).getTime();
    return `PT${Math.max(0, ms / 1000)}S`;
  },
  str: (...args: unknown[]) => args.map(a => (a == null ? "" : String(a))).join(""),
};

export function createBuiltinRegistry(custom: BuiltinRegistry): BuiltinRegistry {
  return { ...defaultBuiltins, ...custom };
}
