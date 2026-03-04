import type {
  ChannelAdapter,
  SendPromptParams,
  ResolvePromptParams,
  PromptConfig,
} from "./types.js";

/** A prompt that was sent via the console channel. */
export interface ConsolePromptRecord {
  workflowId: string;
  prompt: PromptConfig;
  context: Record<string, unknown>;
  resolvedWith?: { event: string; newStateValue: unknown };
}

/**
 * A channel adapter that records prompts in memory. Useful for testing
 * and development — no external dependencies required.
 *
 * ```ts
 * const channel = consoleChannel();
 * const durable = createDurableMachine(machine, { channels: [channel] });
 * // ... run workflow ...
 * console.log(channel.prompts); // inspect what was sent
 * ```
 */
export interface ConsoleChannel extends ChannelAdapter {
  /** All prompts sent through this channel. */
  readonly prompts: readonly ConsolePromptRecord[];
}

export function consoleChannel(): ConsoleChannel {
  const prompts: ConsolePromptRecord[] = [];

  return {
    get prompts() {
      return prompts;
    },

    async sendPrompt(params: SendPromptParams) {
      const record: ConsolePromptRecord = {
        workflowId: params.workflowId,
        prompt: params.prompt,
        context: { ...params.context },
      };
      prompts.push(record);
      return { handle: prompts.length - 1 };
    },

    async resolvePrompt(params: ResolvePromptParams) {
      const idx = params.handle as number;
      if (idx >= 0 && idx < prompts.length) {
        prompts[idx].resolvedWith = {
          event: params.event.type,
          newStateValue: params.newStateValue,
        };
      }
    },
  };
}
