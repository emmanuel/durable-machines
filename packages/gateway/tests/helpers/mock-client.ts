import type { GatewayClient } from "../../src/types.js";
import type { DurableStateSnapshot } from "@durable-xstate/durable-machine";

export interface SendCall {
  workflowId: string;
  message: unknown;
  idempotencyKey?: string;
}

export interface MockClient extends GatewayClient {
  sends: SendCall[];
  stateStubs: Map<string, DurableStateSnapshot>;
  reset(): void;
}

export function createMockClient(): MockClient {
  const sends: SendCall[] = [];
  const stateStubs = new Map<string, DurableStateSnapshot>();

  return {
    sends,
    stateStubs,
    async send(workflowId: string, message: unknown, idempotencyKey?: string): Promise<void> {
      sends.push({ workflowId, message, idempotencyKey });
    },
    async sendBatch(messages: Array<{ workflowId: string; message: unknown; idempotencyKey?: string }>): Promise<void> {
      for (const { workflowId, message, idempotencyKey } of messages) {
        sends.push({ workflowId, message, idempotencyKey });
      }
    },
    async getState(workflowId: string): Promise<DurableStateSnapshot | null> {
      return stateStubs.get(workflowId) ?? null;
    },
    reset() {
      sends.length = 0;
      stateStubs.clear();
    },
  };
}
