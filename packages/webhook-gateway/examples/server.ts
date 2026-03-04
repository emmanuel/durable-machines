import { serve } from "@hono/node-server";
import { createWebhookGateway, genericSource, fieldRouter, directTransform } from "../src/index.js";
import type { GatewayClient } from "../src/index.js";

// In a real app, use DBOSClient from @dbos-inc/dbos-sdk
const client: GatewayClient = {
  async send(workflowId, message, topic) {
    console.log(`[send] ${workflowId} <- ${JSON.stringify(message)} (topic: ${topic})`);
  },
  async getEvent(_workflowId, _key, _timeout) {
    return null;
  },
};

const app = createWebhookGateway({
  client,
  bindings: [
    {
      path: "/webhooks/test",
      source: genericSource(),
      router: fieldRouter((payload: any) => payload.workflowId),
      transform: directTransform((payload: any) => ({
        type: payload.event ?? "webhook.received",
        ...payload,
      })),
    },
  ],
});

serve({ fetch: app.fetch, port: 3001 }, (info) => {
  console.log(`Webhook gateway listening on http://localhost:${info.port}`);
});
