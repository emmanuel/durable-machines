import type { GatewayClient } from "../../src/types.js";

export interface SendCall {
  workflowId: string;
  message: unknown;
  topic: string;
}

export interface MockClient extends GatewayClient {
  sends: SendCall[];
  eventStubs: Map<string, unknown>;
  reset(): void;
}

export function createMockClient(): MockClient {
  const sends: SendCall[] = [];
  const eventStubs = new Map<string, unknown>();

  return {
    sends,
    eventStubs,
    async send(workflowId: string, message: unknown, topic: string): Promise<void> {
      sends.push({ workflowId, message, topic });
    },
    async getEvent<T>(workflowId: string, key: string, _timeoutSeconds?: number): Promise<T | null> {
      const stubKey = `${workflowId}:${key}`;
      return (eventStubs.get(stubKey) as T) ?? null;
    },
    reset() {
      sends.length = 0;
      eventStubs.clear();
    },
  };
}
