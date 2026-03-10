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

## Dependencies

```mermaid
flowchart LR

subgraph 0["packages"]
subgraph 1["gateway"]
subgraph 2["src"]
3["admin.ts"]
subgraph 5["dashboard"]
6["client.ts"]
7["graph.ts"]
15["html.ts"]
16["styles.ts"]
17["index.ts"]
1E["routes.ts"]
end
1D["rest-types.ts"]
1I["hateoas.ts"]
subgraph 1J["dbos"]
1K["index.ts"]
1L["lifecycle.ts"]
end
22["lifecycle.ts"]
2C["gateway.ts"]
2D["middleware.ts"]
2G["types.ts"]
2H["metrics.ts"]
33["rest-api.ts"]
subgraph 34["streams"]
35["checkpoint-store.ts"]
36["types.ts"]
37["consumer.ts"]
3Z["sse-transport.ts"]
end
38["hmac.ts"]
39["index.ts"]
subgraph 3A["routers"]
3B["broadcast.ts"]
3C["field.ts"]
3D["lookup.ts"]
4E["index.ts"]
end
subgraph 3E["sources"]
3F["action-link-types.ts"]
3G["action-link.ts"]
3H["calcom-types.ts"]
3I["calcom.ts"]
3J["generic.ts"]
3K["github-types.ts"]
3L["github.ts"]
3M["linear-types.ts"]
3N["linear.ts"]
3O["slack-slash.ts"]
3P["slack-types.ts"]
3Q["slack.ts"]
3R["stripe-types.ts"]
3S["stripe.ts"]
3T["twilio-types.ts"]
3U["twilio.ts"]
3V["xapi-binding.ts"]
3W["xapi-types.ts"]
3X["xapi.ts"]
3Y["xapi-stream.ts"]
end
subgraph 40["transforms"]
41["direct.ts"]
4F["index.ts"]
end
subgraph 42["pg"]
43["index.ts"]
44["lifecycle.ts"]
end
end
end
subgraph 8["durable-machine"]
subgraph 9["dist"]
A["index.js"]
B["app-context.js"]
subgraph C["channels"]
D["console.js"]
E["email.js"]
G["slack.js"]
H["twilio-sms.js"]
end
subgraph I["definition"]
J["index.js"]
K["create-machine.js"]
T["transform.js"]
U["expressions.js"]
V["validate-definition.js"]
X["registry.js"]
end
S["types.js"]
W["prompt.js"]
Y["durable-state.js"]
Z["effect-collector.js"]
10["effects.js"]
11["schema.js"]
12["validate.js"]
13["visualization.js"]
14["xstate-utils.js"]
subgraph 45["pg"]
46["index.js"]
47["client.js"]
48["config.js"]
49["create-durable-machine.js"]
4A["event-processor.js"]
4B["store-metrics.js"]
4C["store.js"]
4D["visualization.js"]
end
end
end
end
4["http"]
F["crypto"]
subgraph L["node_modules"]
subgraph M[".pnpm"]
subgraph N["xstate@5.28.0"]
subgraph O["node_modules"]
subgraph P["xstate"]
subgraph Q["dist"]
R["xstate.cjs.mjs"]
end
end
end
end
subgraph 18["hono@4.12.5"]
subgraph 19["node_modules"]
subgraph 1A["hono"]
subgraph 1B["dist"]
1C["index.js"]
subgraph 1F["helper"]
subgraph 1G["streaming"]
1H["index.js"]
end
subgraph 2E["factory"]
2F["index.js"]
end
end
subgraph 29["middleware"]
subgraph 2A["trailing-slash"]
2B["index.js"]
end
end
end
end
end
end
subgraph 1M["@dbos-inc+dbos-sdk@4.9.11"]
subgraph 1N["node_modules"]
subgraph 1O["@dbos-inc"]
subgraph 1P["dbos-sdk"]
subgraph 1Q["dist"]
subgraph 1R["src"]
1S["index.js"]
end
end
end
end
end
end
subgraph 1T["pg@8.11.3"]
subgraph 1U["node_modules"]
subgraph 1V["pg"]
subgraph 1W["lib"]
1X["index.js"]
end
end
end
end
subgraph 1Y["zod@4.3.6"]
subgraph 1Z["node_modules"]
subgraph 20["zod"]
21["index.js"]
end
end
end
subgraph 23["@hono+node-server@1.19.10_hono@4.12.5"]
subgraph 24["node_modules"]
subgraph 25["@hono"]
subgraph 26["node-server"]
subgraph 27["dist"]
28["index.js"]
end
end
end
end
end
subgraph 2I["@opentelemetry+api@1.9.0"]
subgraph 2J["node_modules"]
subgraph 2K["@opentelemetry"]
subgraph 2L["api"]
subgraph 2M["build"]
subgraph 2N["src"]
2O["index.js"]
end
end
end
end
end
end
subgraph 2P["@opentelemetry+exporter-prometheus@0.213.0_@opentelemetry+api@1.9.0"]
subgraph 2Q["node_modules"]
subgraph 2R["@opentelemetry"]
subgraph 2S["exporter-prometheus"]
subgraph 2T["build"]
subgraph 2U["src"]
2V["index.js"]
end
end
end
end
end
end
subgraph 2W["@opentelemetry+sdk-metrics@2.6.0_@opentelemetry+api@1.9.0"]
subgraph 2X["node_modules"]
subgraph 2Y["@opentelemetry"]
subgraph 2Z["sdk-metrics"]
subgraph 30["build"]
subgraph 31["src"]
32["index.js"]
end
end
end
end
end
end
end
end
3-->4
3-->4
7-->A
A-->B
A-->D
A-->E
A-->G
A-->H
A-->J
A-->Y
A-->Z
A-->10
A-->W
A-->11
A-->S
A-->12
A-->13
A-->14
E-->F
J-->K
J-->U
J-->X
J-->T
J-->V
K-->S
K-->T
K-->V
K-->R
T-->U
V-->W
Z-->U
Z-->10
11-->R
12-->10
12-->W
12-->S
13-->10
13-->W
13-->12
14-->R
15-->6
15-->7
15-->16
15-->A
17-->1D
17-->1E
17-->1C
1D-->A
1E-->1I
1E-->1D
1E-->7
1E-->7
1E-->15
1E-->15
1E-->A
1E-->A
1E-->1C
1E-->1H
1I-->1D
1I-->A
1K-->1L
1K-->1L
1L-->22
1L-->22
1L-->2H
1L-->37
1L-->2G
1L-->1S
1L-->A
1L-->A
1L-->1C
1L-->4
1L-->1X
1L-->21
22-->3
22-->17
22-->2C
22-->2H
22-->2H
22-->33
22-->1D
22-->35
22-->37
22-->37
22-->36
22-->2G
22-->28
22-->1C
22-->2B
22-->4
22-->1X
22-->21
2C-->2D
2C-->2G
2C-->2G
2C-->1C
2D-->2F
2G-->2H
2G-->A
2G-->1C
2H-->2O
2H-->2V
2H-->32
2H-->4
33-->1I
33-->1D
33-->A
33-->1C
35-->36
36-->2G
36-->A
37-->2H
37-->2G
37-->36
38-->2G
38-->F
39-->3
39-->3
39-->17
39-->17
39-->2C
39-->1I
39-->38
39-->22
39-->22
39-->2H
39-->2H
39-->2D
39-->33
39-->1D
39-->3B
39-->3C
39-->3D
39-->3F
39-->3G
39-->3H
39-->3I
39-->3J
39-->3K
39-->3L
39-->3M
39-->3N
39-->3O
39-->3O
39-->3P
39-->3Q
39-->3R
39-->3S
39-->3T
39-->3U
39-->3V
39-->3V
39-->3Y
39-->3Y
39-->3W
39-->3X
39-->3X
39-->35
39-->37
39-->37
39-->3Z
39-->3Z
39-->36
39-->41
39-->2G
39-->2G
39-->A
3B-->2G
3C-->2G
3D-->2G
3G-->38
3G-->2G
3G-->2G
3G-->3F
3I-->38
3I-->2G
3I-->2G
3I-->3H
3J-->2G
3L-->38
3L-->2G
3L-->2G
3L-->3K
3N-->38
3N-->2G
3N-->2G
3N-->3M
3O-->38
3O-->2G
3O-->2G
3O-->3P
3O-->F
3Q-->38
3Q-->2G
3Q-->2G
3Q-->3P
3Q-->F
3S-->38
3S-->2G
3S-->2G
3S-->3R
3S-->F
3U-->2G
3U-->2G
3U-->3T
3U-->F
3V-->2G
3V-->3W
3V-->3X
3V-->3X
3V-->F
3X-->2G
3X-->2G
3X-->3W
3X-->F
3Y-->3Z
3Y-->3Z
3Y-->36
3Y-->2G
3Y-->3W
3Z-->36
41-->2G
43-->44
43-->44
44-->22
44-->22
44-->2H
44-->37
44-->2G
44-->A
44-->A
44-->46
44-->1C
44-->4
44-->1X
44-->1X
44-->R
46-->47
46-->48
46-->49
46-->4B
46-->4C
46-->4D
49-->S
49-->12
49-->4A
49-->4B
49-->4C
4A-->Y
4A-->Z
4A-->W
4A-->S
4A-->14
4A-->R
4B-->2O
4C-->1X
4D-->13
4E-->3B
4E-->3C
4E-->3D
4F-->41
```

## License

MIT
