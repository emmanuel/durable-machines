import { Hono } from "hono";
import { rawBody } from "./middleware.js";
import {
  WebhookVerificationError,
  WebhookRoutingError,
} from "./types.js";
import type {
  GatewayOptions,
  WebhookBinding,
  RawRequest,
} from "./types.js";

/**
 * Creates a Hono app that receives webhooks, verifies/parses/routes/transforms
 * them, and dispatches XState events via DBOSClient.send().
 *
 * @param options - Gateway configuration (client, bindings, optional basePath).
 * @returns A Hono app with POST routes for each binding.
 *
 * @example
 * ```ts
 * const app = createWebhookGateway({
 *   client: dbosClient,
 *   bindings: [{ path: "/stripe", source: stripeSource(secret), router, transform }],
 * });
 * ```
 */
export function createWebhookGateway(options: GatewayOptions): Hono {
  const { client, bindings, basePath = "" } = options;
  const app = new Hono();

  // Global error handler
  app.onError((err, c) => {
    if (err instanceof WebhookVerificationError) {
      return c.json({ error: err.message, source: err.source }, 401);
    }
    if (err instanceof WebhookRoutingError) {
      return c.json({ error: err.message }, 422);
    }
    return c.json({ error: "Internal server error" }, 500);
  });

  for (const binding of bindings) {
    registerBinding(app, binding, client, basePath);
  }

  return app;
}

function registerBinding(
  app: Hono,
  binding: WebhookBinding<any>,
  client: GatewayOptions["client"],
  basePath: string,
): void {
  const path = `${basePath}${binding.path}`;

  app.post(path, rawBody(), async (c) => {
    const body = c.get("rawBody" as never) as string;
    const headers: Record<string, string | undefined> = {};

    // Extract relevant headers
    for (const key of [
      "x-slack-request-timestamp",
      "x-slack-signature",
      "stripe-signature",
      "x-hub-signature-256",
      "x-github-event",
      "x-github-delivery",
      "linear-signature",
      "x-cal-signature-256",
      "x-twilio-signature",
      "content-type",
    ]) {
      headers[key] = c.req.header(key);
    }

    const rawReq: RawRequest = { headers, body };

    // Verify
    await binding.source.verify(rawReq);

    // Parse
    const payload = await binding.source.parse(rawReq);

    // Check for inline response handler (e.g., slash command ack)
    if (binding.onResponse) {
      const response = await binding.onResponse(payload, c);
      if (response) {
        // Route and dispatch in background if applicable
        const routeResult = await binding.router.route(payload);
        if (routeResult !== null) {
          const event = binding.transform.transform(payload);
          const ids = Array.isArray(routeResult) ? routeResult : [routeResult];
          // Fire and forget — don't block the ack response
          Promise.all(ids.map((id) => client.send(id, event, "xstate.event"))).catch(() => {
            // Swallow errors — webhook already acked
          });
        }
        return response;
      }
    }

    // Route
    const routeResult = await binding.router.route(payload);
    if (routeResult == null) {
      throw new WebhookRoutingError("No target workflow found");
    }

    // Transform
    const event = binding.transform.transform(payload);

    // Dispatch
    const ids = Array.isArray(routeResult) ? routeResult : [routeResult];
    await Promise.all(ids.map((id) => client.send(id, event, "xstate.event")));

    return c.json({ ok: true, dispatched: ids.length });
  });
}
