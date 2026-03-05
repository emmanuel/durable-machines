import { Hono } from "hono";
import { rawBody } from "./middleware.js";
import {
  WebhookVerificationError,
  WebhookRoutingError,
} from "./types.js";
import type {
  GatewayOptions,
  GatewayClient,
  WebhookBinding,
  RawRequest,
  RouteResult,
  ItemRouter,
  ItemTransform,
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
  const { client, bindings, basePath = "", metrics } = options;
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

  // Metrics middleware
  if (metrics) {
    app.use("*", async (c, next) => {
      const start = performance.now();
      await next();
      const durationSec = (performance.now() - start) / 1000;
      const path = c.req.path;
      const status = String(c.res.status);
      metrics.webhooksReceived.inc({ path, status });
      metrics.webhookDuration.observe({ path }, durationSec);
    });
  }

  for (const binding of bindings) {
    registerBinding(app, binding, client, basePath, metrics);
  }

  return app;
}

/** Normalize a RouteResult to an array of workflow IDs (empty array for null/undefined). */
function normalizeRouteResult(result: RouteResult): string[] {
  if (result == null) return [];
  return Array.isArray(result) ? result : [result];
}

/** Dispatch items through the router/transform pipeline, returning total dispatched count. */
async function dispatchItems<TItem>(
  items: TItem[],
  router: ItemRouter<TItem>,
  transform: ItemTransform<TItem>,
  client: GatewayClient,
): Promise<number> {
  let dispatched = 0;
  const sends: Promise<void>[] = [];

  for (const item of items) {
    const routeResult = await router.route(item);
    const ids = normalizeRouteResult(routeResult);
    if (ids.length === 0) continue;

    const event = transform.transform(item);
    for (const id of ids) {
      sends.push(client.send(id, event, "xstate.event"));
      dispatched++;
    }
  }

  await Promise.all(sends);
  return dispatched;
}

function registerBinding(
  app: Hono,
  binding: WebhookBinding<any, any>,
  client: GatewayClient,
  basePath: string,
  metrics?: GatewayOptions["metrics"],
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
      "authorization",
      "x-experience-api-version",
      "content-type",
    ]) {
      headers[key] = c.req.header(key);
    }

    const rawReq: RawRequest = { headers, body };

    // Verify
    await binding.source.verify(rawReq);

    // Parse payload from raw request
    const payload = await binding.source.parse(rawReq);

    // Split payload into items (default: wrap payload as single item)
    const items = binding.parse ? binding.parse(payload) : [payload];

    // Check for inline response handler (e.g., slash command ack, xAPI statement IDs)
    if (binding.onResponse) {
      const response = await binding.onResponse(payload, c);
      if (response) {
        // Item-level dispatch, fire-and-forget
        dispatchItems(items, binding.router, binding.transform, client).catch(() => {
          // Swallow errors — webhook already acked
        });
        return response;
      }
    }

    // Item-level dispatch
    const dispatched = await dispatchItems(items, binding.router, binding.transform, client);

    if (dispatched === 0) {
      throw new WebhookRoutingError("No target workflow found");
    }

    metrics?.webhooksDispatched.inc({ path }, dispatched);

    return c.json({ ok: true, dispatched });
  });
}
