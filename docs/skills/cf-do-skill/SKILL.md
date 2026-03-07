---
name: durable-objects
description: Use this skill whenever the user wants to build stateful serverless applications using Cloudflare Durable Objects. This includes creating Durable Object classes with SQLite or KV storage, building real-time WebSocket servers with hibernation, coordinating state across clients (chat rooms, multiplayer games, collaborative editing), implementing per-entity storage and logic, using the Alarms API for scheduled tasks per object, designing parent-child Durable Object hierarchies, using RPC methods for type-safe communication, managing Durable Object migrations, building rate limiters or counters, using Workers to route requests to Durable Objects, understanding input/output gates and concurrency, using blockConcurrencyWhile(), working with the @cloudflare/actors library, or integrating Durable Objects with D1, KV, R2, or Queues. Trigger this skill even for tangential mentions — if the user says "Durable Object," "stateful Worker," "Cloudflare actor," "WebSocket hibernation," "per-user storage at the edge," "single-threaded coordination," "globally-unique serverless instance," or discusses building real-time multiplayer, collaborative, or chat applications on Cloudflare, use this skill.
---

# Cloudflare Durable Objects Skill

Durable Objects are stateful serverless compute instances on Cloudflare's edge network. Each Durable Object combines single-threaded compute with persistent storage (SQLite or KV), a globally-unique identity, and WebSocket support. They are the building block for coordination, real-time communication, and per-entity state at global scale.

**Reference files** (read as needed — do NOT load all at once):
- `references/api-reference.md` — Full API: DurableObject base class, storage (SQL + KV), state, namespace, stubs, IDs, alarms, WebSocket hibernation, RPC
- `references/patterns.md` — Common recipes: chat room, counter, rate limiter, game session, collaborative editor, parent-child hierarchy, TTL cleanup, polling
- `references/websockets.md` — WebSocket Hibernation API, serializeAttachment, auto-response, cost optimization, connection management
- `references/config-and-ops.md` — Wrangler config, migrations, location hints, pricing, limits, testing with Vitest, troubleshooting

## When to Read References

| User wants to... | Read |
|---|---|
| Build a Durable Object from scratch | This file (continue below) |
| Use a specific API (sql.exec, alarms, blockConcurrencyWhile, etc.) | `references/api-reference.md` |
| See a pattern (chat, game, counter, rate limiter) | `references/patterns.md` |
| Build WebSocket-based real-time apps | `references/websockets.md` |
| Configure wrangler, run migrations, test, deploy | `references/config-and-ops.md` |

---

## Essential Mental Model

1. **Each Durable Object is a single-threaded, globally-unique instance** with its own persistent storage. Think of it as a tiny server with a private database.
2. **Workers are the entry point.** A Worker receives an HTTP request, looks up a Durable Object by name/ID, and calls methods on it via a "stub."
3. **One DO per "atom" of coordination.** Create one Durable Object per chat room, per game session, per user, per document — NOT a single global singleton.
4. **SQLite storage is the recommended backend.** Each DO gets its own embedded SQLite database (up to 10 GB on paid plans). Legacy KV storage still works but SQLite is preferred for new projects.
5. **Durable Objects hibernate when idle.** They are evicted from memory to save costs but can be woken instantly by new requests. WebSocket connections survive hibernation.
6. **RPC methods are preferred over fetch().** Define public methods on your DO class and call them directly from stubs with full TypeScript support (requires compatibility date `2024-04-03`+).
7. **Alarms provide per-object scheduled tasks.** Each DO can set a single alarm that fires at a future time, even if the DO is hibernating.

---

## The Standard Durable Object Template

```ts
import { DurableObject } from "cloudflare:workers";

export interface Env {
  MY_DO: DurableObjectNamespace<MyDurableObject>;
}

// The Durable Object class
export class MyDurableObject extends DurableObject<Env> {
  // In-memory state (lost on hibernation/eviction — use storage for persistence)
  private cachedValue: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Run schema migrations before any requests are processed
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    });
  }

  // RPC method — called directly from Worker stubs
  async addItem(id: string, value: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO items (id, value, created_at) VALUES (?, ?, ?)",
      id, value, Date.now()
    );
  }

  async getItem(id: string): Promise<{ id: string; value: string } | null> {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; value: string }>("SELECT id, value FROM items WHERE id = ?", id)
      .toArray();
    return rows[0] ?? null;
  }

  async listItems(): Promise<{ id: string; value: string }[]> {
    return this.ctx.storage.sql
      .exec<{ id: string; value: string }>("SELECT id, value FROM items ORDER BY created_at DESC")
      .toArray();
  }

  // Alarm handler — fires at a scheduled time
  async alarm(): Promise<void> {
    // Clean up old items
    this.ctx.storage.sql.exec(
      "DELETE FROM items WHERE created_at < ?",
      Date.now() - 86400000 // 24 hours
    );
  }
}

// The Worker entry point
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "default";

    // Get a stub to a specific Durable Object by name
    const id = env.MY_DO.idFromName(name);
    const stub = env.MY_DO.get(id);

    // Call RPC methods directly on the stub
    if (url.pathname === "/add") {
      const { itemId, value } = await request.json<{ itemId: string; value: string }>();
      await stub.addItem(itemId, value);
      return new Response("Added", { status: 201 });
    }

    if (url.pathname === "/list") {
      const items = await stub.listItems();
      return Response.json(items);
    }

    return new Response("Not found", { status: 404 });
  },
};
```

### Wrangler Configuration

```jsonc
// wrangler.jsonc
{
  "name": "my-app",
  "main": "src/index.ts",
  "compatibility_date": "2024-12-01",
  "durable_objects": {
    "bindings": [
      { "name": "MY_DO", "class_name": "MyDurableObject" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MyDurableObject"] }
  ]
}
```

---

## Key Concepts Cheatsheet

### Getting a Stub (from a Worker)

```ts
// By name (deterministic — same name always routes to same DO)
const id = env.MY_DO.idFromName("room-123");
const stub = env.MY_DO.get(id);

// Shorthand (equivalent)
const stub = env.MY_DO.getByName("room-123");

// Random ID (must store mapping externally)
const id = env.MY_DO.newUniqueId();
const stub = env.MY_DO.get(id);

// From string (reconstruct from stored ID)
const id = env.MY_DO.idFromString(storedIdString);
const stub = env.MY_DO.get(id);
```

**Creating a stub does NOT wake the DO.** The DO is only activated when you call a method on it.

### Storage: SQLite (Recommended)

```ts
// In constructor — run migrations
this.ctx.blockConcurrencyWhile(async () => {
  this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT)`);
});

// Write
this.ctx.storage.sql.exec("INSERT INTO users (id, name) VALUES (?, ?)", id, name);

// Read (typed)
const rows = this.ctx.storage.sql
  .exec<{ id: string; name: string }>("SELECT * FROM users WHERE id = ?", id)
  .toArray();

// Iterate with cursor
for (const row of this.ctx.storage.sql.exec("SELECT * FROM users")) {
  console.log(row.id, row.name);
}
```

### Storage: KV (Legacy or Simple Data)

```ts
// Write
await this.ctx.storage.put("key", value);
await this.ctx.storage.put({ key1: val1, key2: val2 }); // Batch

// Read
const value = await this.ctx.storage.get("key");
const values = await this.ctx.storage.get(["key1", "key2"]); // Batch → Map

// Delete
await this.ctx.storage.delete("key");
await this.ctx.storage.deleteAll(); // Remove ALL storage (required for cleanup)

// List
const entries = await this.ctx.storage.list({ prefix: "user:", limit: 100 });
```

### Alarms (Per-Object Scheduled Tasks)

```ts
// Set alarm (only one per DO — setting a new one replaces the old)
await this.ctx.storage.setAlarm(Date.now() + 60000); // Fire in 60 seconds

// Check current alarm
const alarm = await this.ctx.storage.getAlarm(); // Date | null

// Delete alarm
await this.ctx.storage.deleteAlarm();

// Handler (in DO class)
async alarm(): Promise<void> {
  // Do scheduled work
  // Re-set alarm for recurring tasks:
  await this.ctx.storage.setAlarm(Date.now() + 60000);
}
```

Alarms fire even if the DO is hibernating — they wake it up.

### In-Memory State

```ts
export class MyDO extends DurableObject {
  private cache = new Map<string, string>(); // Lost on hibernation/eviction!

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Hydrate from storage on construction
    ctx.blockConcurrencyWhile(async () => {
      const rows = ctx.storage.sql.exec<{ k: string; v: string }>("SELECT k, v FROM cache").toArray();
      for (const row of rows) this.cache.set(row.k, row.v);
    });
  }
}
```

**In-memory state is fast but ephemeral.** Use it as a cache backed by SQLite/KV storage. Always be prepared for the constructor to re-run.

---

## Critical Gotchas

1. **Do NOT create a global singleton DO.** A single DO handles ~500–1,000 req/s. Create one DO per logical entity (room, user, session) for horizontal scaling.

2. **SQLite ops are synchronous; KV ops are async.** `this.ctx.storage.sql.exec()` does not yield the event loop. `this.ctx.storage.get/put()` returns promises.

3. **In-memory state is lost on hibernation.** The constructor re-runs when the DO wakes up. Always persist important state to storage.

4. **Always `await` RPC calls.** Unawaited calls create dangling promises — errors are swallowed, return values lost.

5. **`deleteAll()` is the only way to fully clean up storage.** Dropping tables or deleting keys is not enough — internal metadata remains and incurs billing.

6. **One alarm per DO.** Setting a new alarm replaces the existing one. For multiple timers, track them in storage and use a single alarm that dispatches.

7. **DOs don't know their own name/ID.** If your DO needs its identity, you must pass it explicitly via an `init()` method or constructor pattern.

8. **Input gates prevent interleaving during storage I/O.** While a storage read/write is pending (KV), other requests are blocked from entering the DO. This prevents races but can limit throughput.

9. **`blockConcurrencyWhile()` blocks ALL requests.** Use it only in the constructor for migrations. In regular methods, prefer SQLite (synchronous) or accept input gate behavior.

10. **WebSocket Standard API prevents hibernation.** Use `this.ctx.acceptWebSocket(ws)` (Hibernation API), NOT `ws.accept()`, to allow the DO to hibernate with connections open.

---

## When Generating Durable Object Code

1. **Identify the "atom."** What entity needs coordination? One DO per atom.
2. **Choose storage backend.** SQLite for relational data, KV for simple key-value. SQLite is recommended for all new projects.
3. **Define RPC methods.** Public methods on the DO class = your API. Workers call them via stubs.
4. **Run migrations in the constructor** using `blockConcurrencyWhile()`.
5. **Design the Worker entry point.** Parse the request, determine which DO to route to, call RPC methods, return the response.
6. **Add alarms** if you need per-entity scheduled work (cleanup, TTL, polling).
7. **Use Hibernatable WebSockets** for real-time features (chat, live updates, multiplayer).
8. **Configure wrangler.jsonc** with bindings and migrations.
9. **Test with Vitest** using `@cloudflare/vitest-pool-workers`.
10. **Deploy with `wrangler deploy`.**
