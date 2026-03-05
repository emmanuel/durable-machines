import { serve } from "@hono/node-server";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  createWebhookGateway,
  slackSource,
  genericSource,
  fieldRouter,
  directTransform,
} from "@xstate-dbos/webhook-gateway";
import type { SlackInteractivePayload } from "@xstate-dbos/webhook-gateway";

interface GenericPayload {
  workflowId?: string;
  event?: string;
  data?: Record<string, unknown>;
}

async function main() {
  const dbUrl = process.env.DBOS_DATABASE_URL || "postgresql://localhost:5432/dbos";
  const client = await DBOSClient.create({ systemDatabaseUrl: dbUrl });

  const gateway = createWebhookGateway({
    client,
    bindings: [
      // Slack interactive webhooks (production)
      {
        path: "/webhooks/slack",
        source: slackSource(process.env.SLACK_SIGNING_SECRET || "dev-secret"),
        router: fieldRouter<SlackInteractivePayload>((payload) => {
          // Extract workflow ID from Slack action value
          const action = payload.actions?.[0];
          return action?.value || null;
        }),
        transform: directTransform<SlackInteractivePayload>((payload) => {
          const action = payload.actions?.[0];
          return { type: action?.action_id || "UNKNOWN" };
        }),
      },
      // Generic webhook (development / testing)
      {
        path: "/webhooks/generic",
        source: genericSource<GenericPayload>(),
        router: fieldRouter<GenericPayload>((payload) => payload.workflowId || null),
        transform: directTransform<GenericPayload>((payload) => ({
          type: payload.event || "UNKNOWN",
          ...payload.data,
        })),
      },
    ],
  });

  serve({ fetch: gateway.fetch, port: 3000 }, (info) => {
    console.log(`Gateway listening on http://localhost:${info.port}`);
    console.log("POST /webhooks/slack    — Slack interactive webhooks");
    console.log("POST /webhooks/generic  — Generic JSON webhooks (dev)");
  });
}

main().catch(console.error);
