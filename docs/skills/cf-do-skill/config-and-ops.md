# Durable Objects Configuration & Operations

## Table of Contents

1. [Wrangler Configuration](#wrangler-configuration)
2. [Migrations](#migrations)
3. [Location Hints and Data Residency](#location-hints-and-data-residency)
4. [Testing with Vitest](#testing-with-vitest)
5. [Pricing](#pricing)
6. [Limits](#limits)
7. [Troubleshooting](#troubleshooting)
8. [The @cloudflare/actors Library](#the-cloudflareactors-library)
9. [Deploying](#deploying)

---

## Wrangler Configuration

### Basic Configuration (wrangler.jsonc)

```jsonc
{
  "name": "my-app",
  "main": "src/index.ts",
  "compatibility_date": "2024-12-01",  // Use latest for RPC support

  // Durable Object bindings — how Workers access DO classes
  "durable_objects": {
    "bindings": [
      {
        "name": "MY_DO",                 // Binding name (used in env.MY_DO)
        "class_name": "MyDurableObject"   // Exported class name
      },
      {
        "name": "CHAT_ROOM",
        "class_name": "ChatRoom"
      }
    ]
  },

  // Migrations — define storage backends and class lifecycle
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["MyDurableObject", "ChatRoom"]  // SQLite backend
    }
  ]
}
```

### CPU Limits

```jsonc
{
  "limits": {
    "cpu_ms": 60000  // Increase CPU time per invocation (default: 30000ms)
  }
}
```

### Multiple DO Classes

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "COUNTER", "class_name": "Counter" },
      { "name": "CHAT", "class_name": "ChatRoom" },
      { "name": "USER", "class_name": "UserData" }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["Counter", "ChatRoom", "UserData"]
    }
  ]
}
```

### Cross-Worker Bindings

A DO class can be defined in one Worker and accessed from another:

```jsonc
// In the consuming Worker's wrangler.jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "EXTERNAL_DO",
        "class_name": "SomeClass",
        "script_name": "other-worker"  // The Worker that defines the class
      }
    ]
  }
}
```

### TypeScript Env Interface

```ts
export interface Env {
  MY_DO: DurableObjectNamespace<MyDurableObject>;
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  // Other bindings
  KV_STORE: KVNamespace;
  DB: D1Database;
  BUCKET: R2Bucket;
}
```

---

## Migrations

Migrations are how you tell the Cloudflare runtime about Durable Object class changes. They are defined in `wrangler.jsonc` and applied at deploy time.

### Creating a New Class (SQLite)

```jsonc
{
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MyNewClass"] }
  ]
}
```

### Creating a New Class (Legacy KV)

```jsonc
{
  "migrations": [
    { "tag": "v1", "new_classes": ["MyNewClass"] }
  ]
}
```

### Renaming a Class

```jsonc
{
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["OldName"] },
    { "tag": "v2", "renamed_classes": [{ "from": "OldName", "to": "NewName" }] }
  ]
}
```

### Deleting a Class

```jsonc
{
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ToBeDeleted"] },
    { "tag": "v2", "deleted_classes": ["ToBeDeleted"] }
  ]
}
```

### Schema Migrations (Within a DO)

Use `blockConcurrencyWhile()` in the constructor. Track version with a migration table:

```ts
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  ctx.blockConcurrencyWhile(async () => {
    this.runMigrations();
  });
}

private runMigrations(): void {
  this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY)");

  const current = this.ctx.storage.sql
    .exec<{ version: number }>("SELECT MAX(version) as version FROM _migrations")
    .one().version ?? 0;

  if (current < 1) {
    this.ctx.storage.sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT)");
    this.ctx.storage.sql.exec("INSERT INTO _migrations (version) VALUES (1)");
  }

  if (current < 2) {
    this.ctx.storage.sql.exec("ALTER TABLE items ADD COLUMN created_at INTEGER");
    this.ctx.storage.sql.exec("INSERT INTO _migrations (version) VALUES (2)");
  }
}
```

**Note:** `PRAGMA user_version` is NOT supported in Durable Objects SQLite. Use a migration table.

---

## Location Hints and Data Residency

### Location Hints

Influence where a DO is initially created:

```ts
const id = env.MY_DO.idFromName("room-eu");
const stub = env.MY_DO.get(id, { locationHint: "weur" }); // Western Europe
```

| Hint | Region |
|---|---|
| `wnam` | Western North America |
| `enam` | Eastern North America |
| `sam` | South America |
| `weur` | Western Europe |
| `eeur` | Eastern Europe |
| `apac` | Asia-Pacific |
| `oc` | Oceania |
| `afr` | Africa |
| `me` | Middle East |

Location hints are **suggestions, not guarantees.** They only matter at creation time.

### EU Jurisdiction

For GDPR compliance, restrict a DO to EU data centers:

```ts
const id = env.MY_DO.newUniqueId({ jurisdiction: "eu" });
```

EU jurisdiction DOs are guaranteed to run and store data within the EU.

---

## Testing with Vitest

Use `@cloudflare/vitest-pool-workers` for testing Durable Objects locally.

### Setup

```bash
npm install -D vitest @cloudflare/vitest-pool-workers
```

```ts
// vitest.config.ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
```

### Basic Test

```ts
import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Counter DO", () => {
  it("increments", async () => {
    const id = env.COUNTER.idFromName("test");
    const stub = env.COUNTER.get(id);

    const count = await stub.increment();
    expect(count).toBe(1);

    const count2 = await stub.increment();
    expect(count2).toBe(2);
  });

  it("returns 0 for new counter", async () => {
    const stub = env.COUNTER.getByName("new-counter");
    const count = await stub.get();
    expect(count).toBe(0);
  });
});
```

### Testing via Worker fetch

```ts
it("handles requests through the Worker", async () => {
  const response = await SELF.fetch("https://test.local/increment?name=test");
  const data = await response.json();
  expect(data.value).toBe(1);
});
```

### Testing Alarms

```ts
import { runDurableObjectAlarm } from "cloudflare:test";

it("alarm cleans up expired data", async () => {
  const id = env.MY_DO.idFromName("test-alarm");
  const stub = env.MY_DO.get(id);

  await stub.addExpiredItem("old-item");

  // Trigger alarm manually
  const alarmRan = await runDurableObjectAlarm(id);
  expect(alarmRan).toBe(true);

  const items = await stub.listItems();
  expect(items).toHaveLength(0);
});
```

---

## Pricing

### Workers Paid Plan ($5/month base)

| Component | Price |
|---|---|
| Requests (RPC/fetch/alarm) | $0.15 per million (first 1M included) |
| Duration (wall-clock time) | $12.50 per million GB-s |
| Reads (SQLite rows read) | $0.001 per million rows (first 25B included) |
| Writes (SQLite rows written) | $1.00 per million rows (first 50M included) |
| Storage (SQLite) | $0.20 per GB-month (first 5 GB included) |
| KV storage (legacy) | $0.20 per GB-month |

### Workers Free Plan

SQLite-backed DOs only. Limits:
- 1M requests/month
- 5 GB total storage
- 1 GB per individual DO
- Limited to SQLite backend

### Key Cost Insight

**Hibernation** is the #1 cost saver. WebSocket-connected DOs that use the Hibernation API only incur duration charges while actively processing messages, not while idle with connections open.

---

## Limits

| Resource | Free Plan | Paid Plan |
|---|---|---|
| Storage per DO | 1 GB | 10 GB |
| Storage per account | 5 GB total | Unlimited |
| Requests per DO | ~1,000/s (soft) | ~1,000/s (soft) |
| Number of DOs per namespace | Unlimited | Unlimited |
| CPU time per invocation | 30s (default) | Configurable |
| WebSocket connections per DO | Thousands (practical) | Thousands (practical) |
| Alarm precision | ~1 second | ~1 second |
| SQLite row size | 2 MB max | 2 MB max |
| SQLite columns per table | 100 | 100 |

---

## Troubleshooting

### Common Errors

**"Durable Object storage is not available"**
→ You're trying to use `sql.exec()` on a KV-backed DO. Add `new_sqlite_classes` in migrations.

**"Durable Object has been broken"**
→ Uncaught exception or `this.ctx.abort()` was called. The DO will restart on the next request.

**"Durable Object is overloaded"**
→ Too many concurrent requests (>1,000/s). Shard across more DOs.

**"This Durable Object has been reset"**
→ The DO was forcibly restarted (e.g., deployment, platform maintenance). In-memory state is lost; storage is preserved.

**WebSockets disconnect after deploy**
→ Expected. WebSocket connections are terminated during deploys. Clients should implement reconnection logic.

**Alarm doesn't fire**
→ Check that the alarm time is in the future. Check that `deleteAlarm()` wasn't called. Alarms are cancelled if `deleteAll()` is called.

### Debugging

```ts
// Log in DO handlers
DBOS.logger or console.log — both work in Durable Objects

// View logs
wrangler tail           # Real-time logs
wrangler tail --format pretty

// Local development
wrangler dev            # Runs DOs locally with SQLite
```

---

## The @cloudflare/actors Library

A higher-level SDK for building on Durable Objects (beta as of mid-2025):

```bash
npm install @cloudflare/actors
```

Provides:
- `Actor` base class with storage helpers
- SQL schema migration utilities
- Typed event broadcasting
- Client SDK for frontend frameworks

```ts
import { Actor } from "@cloudflare/actors";

export class MyActor extends Actor<Env> {
  // Storage helpers, migration support, etc.
  // See @cloudflare/actors documentation for details
}
```

The `Actor` class extends `DurableObject` — all DO APIs still work. Use `@cloudflare/actors` when you want higher-level abstractions for common patterns.

---

## Deploying

```bash
# Local development
wrangler dev

# Deploy to Cloudflare
wrangler deploy

# Deploy to specific environment
wrangler deploy --env production

# View deployed DOs
wrangler durable-objects list

# Delete a DO namespace (WARNING: deletes all data)
wrangler durable-objects delete <namespace-name>
```

### Gradual Deployments

Durable Objects support gradual deployments through Cloudflare's deployment system. New versions of your DO code are rolled out progressively. Existing DO instances continue running old code until they are evicted and restarted, at which point they pick up the new code.

In-flight requests complete on the old code. The DO constructor re-runs with the new code on the next activation.
