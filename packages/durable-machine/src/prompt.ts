import type { PromptConfig } from "./types.js";
import type { EffectConfig } from "./effects.js";
import { compileInput } from "./definition/desugar-input.js";

const META_KEY = "xstate-durable";

/**
 * Marks a durable state with a prompt — metadata describing what to
 * show the user while the machine waits for input.
 *
 * Spread into a state definition alongside `durableState()`:
 * ```ts
 * waitingForApproval: {
 *   ...durableState(),
 *   ...prompt({ type: "choice", text: "Approve?", options: [...] }),
 *   on: { APPROVE: "approved", REJECT: "rejected" },
 * }
 * ```
 *
 * Optionally attach effects that fire on state entry:
 * ```ts
 * waitingForApproval: {
 *   ...prompt(
 *     { type: "choice", text: "Approve?", options: [...] },
 *     { effects: [{ type: "webhook", url: "..." }] },
 *   ),
 *   on: { APPROVE: "approved", REJECT: "rejected" },
 * }
 * ```
 */
export function prompt(config: PromptConfig, options?: { effects?: EffectConfig[] }) {
  const hasEffects = options?.effects && options.effects.length > 0;
  return {
    meta: {
      [META_KEY]: {
        durable: true,
        prompt: config,
        ...(hasEffects ? {
          effects: options!.effects,
          compiledEffects: options!.effects!.map((e) => compileInput(e)),
        } : {}),
      },
    },
  } as const;
}

/**
 * Extracts the prompt config from a state node's metadata, if present.
 *
 * @param stateNodeMeta - The `.meta` object from a state node
 * @returns The {@link PromptConfig} if present, or `null` if the state has no prompt
 */
export function getPromptConfig(
  stateNodeMeta: Record<string, any> | undefined,
): PromptConfig | null {
  return stateNodeMeta?.[META_KEY]?.prompt ?? null;
}

/**
 * Returns all event types referenced by a prompt config.
 *
 * @param config - The prompt configuration to extract events from
 * @returns Array of XState event type strings referenced by the prompt
 */
export function getPromptEvents(config: PromptConfig): string[] {
  switch (config.type) {
    case "choice":
      return config.options.map((opt) => opt.event);
    case "confirm":
      return [config.confirmEvent, config.cancelEvent];
    case "text_input":
      return [config.event];
    case "form":
      return [config.event];
  }
}
