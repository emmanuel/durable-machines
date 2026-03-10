# @durable-xstate/gateway

Webhook gateway for routing external webhooks to durable XState machines. Receives HTTP webhooks from providers (Slack, Stripe, GitHub, Linear, Cal.com, Twilio, etc.), verifies signatures, routes to target workflow(s), and dispatches XState events.

Built on [Hono](https://hono.dev/) for the webhook HTTP layer and a plain `node:http` server for the admin/metrics port.

## Install

```bash
npm install @durable-xstate/gateway
```

## Quick start (generic)

```typescript
import {
  parseGatewayConfig,
  createGatewayContext,
  startGateway,
  stripeSource,
  fieldRouter,
  directTransform,
} from "@durable-xstate/gateway";
import type { StripeWebhookEvent, GatewayClient } from "@durable-xstate/gateway";

// Bring your own client that talks to your backend
const client: GatewayClient = { send, sendBatch, getState };

const config = parseGatewayConfig();
const ctx = await createGatewayContext(config, client, {
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
const handle = startGateway(ctx);
```

## DBOS backend

```typescript
import {
  parseDBOSGatewayConfig,
  createDBOSGatewayContext,
  startDBOSGateway,
} from "@durable-xstate/gateway/dbos";

const config = parseDBOSGatewayConfig();
const ctx = await createDBOSGatewayContext(config, { bindings: [...] });
startDBOSGateway(ctx);
```

Requires `@dbos-inc/dbos-sdk` peer dependency. Reads `DBOS_DATABASE_URL` from the environment.

## PG backend

```typescript
import {
  createPgGatewayContext,
  startPgGateway,
} from "@durable-xstate/gateway/pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const config = parseGatewayConfig();
const ctx = await createPgGatewayContext(config, pool, { bindings: [...] });
startPgGateway(ctx);
```

Requires `pg` peer dependency.

## `GatewayClient` interface

The gateway talks to backends via a minimal `GatewayClient` interface:

```typescript
interface GatewayClient {
  send<T>(workflowId: string, message: T, topic: string): Promise<void>;
  sendBatch<T>(messages: Array<{ workflowId: string; message: T; topic: string }>): Promise<void>;
  getState(workflowId: string): Promise<DurableStateSnapshot | null>;
}
```

- `send` / `sendBatch` — dispatch events to running workflows.
- `getState` — retrieve the current durable state snapshot (used by slash command status lookups).

## Architecture

A webhook binding wires five components to a URL path:

```
POST /webhooks/stripe
  → Source (verify HMAC, parse JSON → payload)
  → Parse (split payload → items[]; default: [payload])
  → Router (per-item → workflow ID(s))
  → Transform (per-item → XState event)
  → Dispatch (client.send → durable machine)
```

Both webhooks and streams use the same item-level `ItemRouter` / `ItemTransform` interfaces. A webhook binding without `parse` wraps the payload as a single-item array, so simple bindings work unchanged. When `parse` is provided, multi-item payloads (e.g. xAPI statement batches) fan out per-item.

Each component is a small, replaceable interface. Mix and match built-in implementations or write your own.

## Three-phase startup

| Phase | Function | What it does |
|-------|----------|--------------|
| 1. Parse | `parseGatewayConfig()` | Validates env vars, returns typed config |
| 2. Build | `createGatewayContext()` | Creates metrics, builds Hono app, creates admin server |
| 3. Run | `startGateway()` | Binds webhook + admin ports, returns shutdown handle |

## Configuration

| Env var | Type | Default | Description |
|---------|------|---------|-------------|
| `PORT` | number | `3000` | Webhook listener port |
| `ADMIN_PORT` | number | `9090` | Admin/metrics port |
| `DATABASE_URL` or `DBOS_DATABASE_URL` | string | *(optional)* | Postgres URL (required for stream checkpoints) |
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
interface ItemRouter<TItem> {
  route(item: TItem): RouteResult | Promise<RouteResult>;
}
type RouteResult = string | string[] | null;  // workflow ID(s), or null to skip
```

## Transforms

Transforms map provider payloads to XState events.

| Transform | Factory | Description |
|-----------|---------|-------------|
| Direct | `directTransform(extractFn)` | Map payload to event with a pure function |

### Custom transforms

```typescript
interface ItemTransform<TItem> {
  transform(item: TItem): XStateEvent;
}
```

## Bindings

A binding wires source + router + transform to a URL path:

```typescript
interface WebhookBinding<TPayload = unknown, TItem = TPayload> {
  path: string;
  source: WebhookSource<TPayload>;
  parse?: (payload: TPayload) => TItem[];   // default: [payload]
  router: ItemRouter<TItem>;
  transform: ItemTransform<TItem>;
  onResponse?: (payload: TPayload, c: Context) => Response | null;  // optional inline ack
}
```

When `parse` is omitted, the payload is wrapped as `[payload]` and routed/transformed as a single item. When provided, each item is routed and dispatched independently (fan-out).

The optional `onResponse` hook lets bindings send an immediate response (e.g. Slack 3-second ack, xAPI statement IDs) while item dispatch proceeds fire-and-forget in the background.

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

## HMAC utilities

Low-level helpers for building custom sources:

```typescript
import { computeHmac, verifyHmac } from "@durable-xstate/gateway";

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
2. HTTP servers drain (force-close at 80% of `shutdownTimeoutMs`)
3. Stream consumers stop (final checkpoint saved)
4. Checkpoint pool closes
5. Process exits

When using PG or DBOS backends, shutdown is integrated with `AppContext` — signal handlers are wired automatically and stream consumers are stopped during `backend.stop()`. For direct `startGateway()` usage, call `handle.shutdown()` manually.

## License

MIT
