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
  XStateEvent,
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
  const { client, bindings, basePath = "", metrics, maxBodyBytes, forTenantClient } = options;
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
      metrics.webhooksReceived.add(1, { path, status });
      metrics.webhookDuration.record(durationSec, { path });
    });
  }

  for (const binding of bindings) {
    const effectiveClient = binding.tenantId && forTenantClient
      ? forTenantClient(binding.tenantId)
      : client;
    registerBinding(app, binding, effectiveClient, basePath, metrics, maxBodyBytes);
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
  extractKey?: (item: TItem) => string | undefined,
): Promise<number> {
  const batch: Array<{ workflowId: string; message: XStateEvent; idempotencyKey?: string }> = [];

  for (const item of items) {
    const routeResult = await router.route(item);
    const ids = normalizeRouteResult(routeResult);
    if (ids.length === 0) continue;

    const event = transform.transform(item);
    const key = extractKey?.(item);
    for (const id of ids) {
      batch.push({ workflowId: id, message: event, idempotencyKey: key });
    }
  }

  if (batch.length === 0) return 0;

  await client.sendBatch(batch);
  return batch.length;
}

function registerBinding(
  app: Hono,
  binding: WebhookBinding<any, any>,
  client: GatewayClient,
  basePath: string,
  metrics?: GatewayOptions["metrics"],
  maxBodyBytes?: number,
): void {
  const path = `${basePath}${binding.path}`;

  app.post(path, rawBody({ maxBodyBytes }), async (c) => {
    const body = c.get("rawBody" as never) as string;
    const headers: Record<string, string | undefined> = {};

    // Pass all headers so custom webhook sources can access non-standard signature headers
    for (const [key, value] of c.req.raw.headers.entries()) {
      headers[key] = value;
    }

    const rawReq: RawRequest = { headers, body };

    // Verify
    await binding.source.verify(rawReq);

    // Parse payload from raw request
    const payload = await binding.source.parse(rawReq);

    // Split payload into items (default: wrap payload as single item)
    const items = binding.parse ? binding.parse(payload) : [payload];

    // Build key extractor closure that captures rawReq for this request
    const extractKey = binding.idempotencyKey
      ? (item: any) => binding.idempotencyKey!(item, rawReq)
      : undefined;

    // Check for inline response handler (e.g., slash command ack, xAPI statement IDs)
    if (binding.onResponse) {
      const response = await binding.onResponse(payload, c);
      if (response) {
        // Item-level dispatch, fire-and-forget
        dispatchItems(items, binding.router, binding.transform, client, extractKey).catch((err) => {
          metrics?.webhooksReceived?.add(1, { path: binding.path, status: "dispatch_error" });
          console.error("[gateway] background dispatch failed:", binding.path, err);
        });
        return response;
      }
    }

    // Item-level dispatch
    const dispatched = await dispatchItems(items, binding.router, binding.transform, client, extractKey);

    if (dispatched === 0) {
      throw new WebhookRoutingError("No target workflow found");
    }

    metrics?.webhooksDispatched.add(dispatched, { path });

    return c.json({ ok: true, dispatched });
  });
}
