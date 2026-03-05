# @xstate-dbos/webhook-gateway

Webhook gateway for routing external webhooks to durable XState machines. Receives HTTP webhooks from providers (Slack, Stripe, GitHub, Linear, Cal.com, Twilio, etc.), verifies signatures, routes to target workflow(s), and dispatches XState events via `DBOSClient`.

Built on [Hono](https://hono.dev/) for the webhook HTTP layer and a plain `node:http` server for the admin/metrics port.

## Install

```bash
npm install @xstate-dbos/webhook-gateway
```

Peer dependency: `@dbos-inc/dbos-sdk`.

## Quick start

```typescript
import {
  parseGatewayConfig,
  createGatewayContext,
  startGateway,
  stripeSource,
  fieldRouter,
  directTransform,
} from "@xstate-dbos/webhook-gateway";
import type { StripeWebhookEvent } from "@xstate-dbos/webhook-gateway";

// 1. Parse config from environment
const config = parseGatewayConfig();

// 2. Create context (connects DBOSClient, builds Hono app)
const ctx = await createGatewayContext(config, {
  bindings: [
    {
      path: "/webhooks/stripe",
      source: stripeSource(process.env.STRIPE_WEBHOOK_SECRET!),
      router: fieldRouter<StripeWebhookEvent>((p) => p.data?.object?.metadata?.workflowId ?? null),
      transform: directTransform<StripeWebhookEvent>((p) => ({
        type: `stripe.${p.type}`,
        id: p.id,
      })),
    },
  ],
});

// 3. Start (binds webhook + admin ports, installs signal handlers)
startGateway(ctx);
```

## Architecture

A webhook binding wires four components to a URL path:

```
POST /webhooks/stripe
  → Source (verify HMAC, parse JSON)
  → Router (extract workflow ID from payload)
  → Transform (map payload → XState event)
  → Dispatch (DBOSClient.send → durable machine)
```

Each component is a small, replaceable interface. Mix and match built-in implementations or write your own.

## Three-phase startup

| Phase | Function | What it does |
|-------|----------|--------------|
| 1. Parse | `parseGatewayConfig()` | Validates env vars, returns typed config |
| 2. Build | `createGatewayContext()` | Connects `DBOSClient`, creates metrics, builds Hono app, creates admin server |
| 3. Run | `startGateway()` | Binds webhook + admin ports, installs signal handlers, returns shutdown handle |

## Configuration

| Env var | Type | Default | Description |
|---------|------|---------|-------------|
| `PORT` | number | `3000` | Webhook listener port |
| `ADMIN_PORT` | number | `9090` | Admin/metrics port |
| `DBOS_DATABASE_URL` | string | *(required)* | Postgres connection URL for `DBOSClient` |
| `GRACEFUL_SHUTDOWN_TIMEOUT_MS` | number | `30000` | Drain timeout on shutdown |

## Webhook sources

Sources handle signature verification and payload parsing for each provider.

| Source | Factory | Signature method |
|--------|---------|-----------------|
| Slack interactive | `slackSource(signingSecret)` | HMAC-SHA256 (`x-slack-signature`) |
| Slack slash commands | `slashCommandBinding(config)` | HMAC-SHA256 + instant ack response |
| Stripe | `stripeSource(endpointSecret)` | HMAC-SHA256 (`stripe-signature`, with `t=` timestamp) |
| GitHub | `githubSource(webhookSecret)` | HMAC-SHA256 (`x-hub-signature-256`) |
| Linear | `linearSource(webhookSecret)` | HMAC-SHA256 (`linear-signature`) |
| Cal.com | `calcomSource(webhookSecret)` | HMAC-SHA256 (`x-cal-signature-256`) |
| Twilio | `twilioSource(authToken)` | HMAC-SHA1 (`x-twilio-signature`) |
| Action link | `actionLinkSource(secret)` | HMAC-SHA256 (signed URL token) |
| Generic | `genericSource()` | None (dev/testing only) |

### Custom sources

Implement the `WebhookSource<TPayload>` interface:

```typescript
interface WebhookSource<TPayload> {
  verify(req: RawRequest): Promise<void>;  // throw WebhookVerificationError on failure
  parse(req: RawRequest): Promise<TPayload>;
}
```

## Routers

Routers determine which workflow(s) receive the event.

| Router | Factory | Description |
|--------|---------|-------------|
| Field | `fieldRouter(extractFn)` | Extract workflow ID(s) directly from the payload |
| Lookup | `lookupRouter(extractKey, queryFn)` | Extract a key, then async lookup (e.g. DB query) |
| Broadcast | `broadcastRouter(filterFn, queryFn)` | Fan-out to all matching workflows |

### Custom routers

```typescript
interface WebhookRouter<TPayload> {
  route(payload: TPayload): RouteResult | Promise<RouteResult>;
}
type RouteResult = string | string[] | null;  // workflow ID(s), or null for no match
```

## Transforms

Transforms map provider payloads to XState events.

| Transform | Factory | Description |
|-----------|---------|-------------|
| Direct | `directTransform(extractFn)` | Map payload to event with a pure function |

### Custom transforms

```typescript
interface WebhookTransform<TPayload> {
  transform(payload: TPayload): XStateEvent;
}
```

## Bindings

A binding wires source + router + transform to a URL path:

```typescript
interface WebhookBinding<TPayload> {
  path: string;
  source: WebhookSource<TPayload>;
  router: WebhookRouter<TPayload>;
  transform: WebhookTransform<TPayload>;
  onResponse?: (payload: TPayload, c: Context) => Response | null;  // optional inline ack
}
```

The optional `onResponse` hook lets sources like Slack slash commands send an immediate acknowledgment while dispatching the event in the background.

## Admin server

A separate HTTP server on `ADMIN_PORT` with:

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Always returns `200 { "status": "ok" }` |
| `GET /ready` | Returns `200` when ready, `503` during shutdown |
| `GET /metrics` | Prometheus text format metrics |

## Metrics

Prometheus metrics collected automatically:

| Metric | Labels | Description |
|--------|--------|-------------|
| `webhook_gateway_received_total` | `path`, `status` | Total webhooks received |
| `webhook_gateway_dispatched_total` | `path` | Total webhooks successfully dispatched |
| `webhook_gateway_duration_seconds` | `path` | Webhook processing duration |

Default process metrics (CPU, memory, event loop) are also collected.

To create metrics independently:

```typescript
import { createGatewayMetrics } from "@xstate-dbos/webhook-gateway";

const metrics = createGatewayMetrics();         // creates its own Registry
const metrics = createGatewayMetrics(registry);  // uses an existing Registry
```

## HMAC utilities

Low-level helpers for building custom sources:

```typescript
import { computeHmac, verifyHmac } from "@xstate-dbos/webhook-gateway";

const hex = computeHmac("sha256", secret, body);
verifyHmac("sha256", secret, body, expectedHex, "my-provider");  // throws on mismatch
```

`verifyHmac` uses timing-safe comparison and throws `WebhookVerificationError` on failure.

## Errors

| Error | HTTP status | When |
|-------|-------------|------|
| `WebhookVerificationError` | 401 | Signature verification fails |
| `WebhookRoutingError` | 422 | Router returns `null` (no target workflow) |

## Graceful shutdown

On `SIGTERM` or `SIGINT`:

1. Readiness probe starts returning `503`
2. Webhook server stops accepting new connections
3. In-flight requests drain up to `shutdownTimeoutMs`
4. Admin server closes
5. `DBOSClient` disconnects
6. Process exits

## License

MIT
