import type { PromptConfig } from "./types.js";

const META_KEY = "xstate-dbos";

/**
 * Marks a quiescent state with a prompt — metadata describing what to
 * show the user while the machine waits for input.
 *
 * Spread into a state definition alongside `quiescent()`:
 * ```ts
 * waitingForApproval: {
 *   ...quiescent(),
 *   ...prompt({ type: "choice", text: "Approve?", options: [...] }),
 *   on: { APPROVE: "approved", REJECT: "rejected" },
 * }
 * ```
 */
export function prompt(config: PromptConfig) {
  return {
    meta: { [META_KEY]: { quiescent: true, prompt: config } },
  } as const;
}

/**
 * Extracts the prompt config from a state node's metadata, if present.
 */
export function getPromptConfig(
  stateNodeMeta: Record<string, any> | undefined,
): PromptConfig | null {
  return stateNodeMeta?.[META_KEY]?.prompt ?? null;
}

/**
 * Returns all event types referenced by a prompt config.
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
