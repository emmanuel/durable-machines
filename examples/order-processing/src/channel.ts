import type {
  ChannelAdapter,
  SendPromptParams,
  ResolvePromptParams,
} from "@durable-machines/machine";

/**
 * A minimal channel adapter that logs prompts and resolutions to the console.
 * Useful for local development and smoke-testing the workflow loop.
 */
export function logChannel(): ChannelAdapter {
  return {
    async sendPrompt(params: SendPromptParams) {
      const text =
        typeof params.prompt.text === "function"
          ? params.prompt.text({ context: params.context })
          : params.prompt.text;

      console.log(`[Prompt] Workflow ${params.workflowId}: ${text}`);
      return { handle: params.workflowId };
    },

    async resolvePrompt(params: ResolvePromptParams) {
      console.log(`[Resolved] Event: ${params.event.type}`);
    },
  };
}
