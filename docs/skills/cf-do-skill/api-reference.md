# Durable Objects API Reference

## Table of Contents

1. [DurableObject Base Class](#durableobject-base-class)
2. [DurableObjectState (this.ctx)](#durableobjectstate-thisctx)
3. [SQLite Storage API](#sqlite-storage-api)
4. [KV Storage API (Legacy)](#kv-storage-api-legacy)
5. [Alarms API](#alarms-api)
6. [DurableObjectNamespace (Bindings)](#durableobjectnamespace-bindings)
7. [DurableObjectId](#durableobjectid)
8. [DurableObjectStub](#durableobjectstub)
9. [RPC Methods](#rpc-methods)
10. [fetch() Handler (Legacy)](#fetch-handler-legacy)
11. [Input and Output Gates](#input-and-output-gates)
12. [blockConcurrencyWhile()](#blockconcurrencywhile)
13. [Point-in-Time Recovery](#point-in-time-recovery)
14. [Location Hints](#location-hints)

---

## DurableObject Base Class

All Durable Objects extend the `DurableObject` base class:

```ts
import { DurableObject } from "cloudflare:workers";

export class MyDO extends DurableObject<Env> {
  // Constructor — called when DO is instantiated (including after hibernation)
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // ctx = DurableObjectState (storage, WebSocket methods, etc.)
    // env = Worker environment bindings (KV, D1, R2, other DO namespaces, etc.)
  }

  // RPC methods — called from Worker stubs
  async myMethod(arg: string): Promise<string> { /* ... */ }

  // HTTP handler (legacy — prefer RPC)
  async fetch(request: Request): Promise<Response> { /* ... */ }

  // Alarm handler
  async alarm(): Promise<void> { /* ... */ }

  // WebSocket Hibernation handlers
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> { /* ... */ }
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> { /* ... */ }
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> { /* ... */ }
}
```

### Available Properties

| Property | Type | Description |
|---|---|---|
| `this.ctx` | `DurableObjectState` | State interface (storage, WebSocket, concurrency) |
| `this.env` | `Env` | Worker environment bindings |

---

## DurableObjectState (this.ctx)

### Properties

| Property | Type | Description |
|---|---|---|
| `this.ctx.storage` | `DurableObjectStorage` | Access to SQL, KV, alarms, PITR |
| `this.ctx.storage.sql` | `SqlStorage` | SQLite query interface |
| `this.ctx.id` | `DurableObjectId` | This DO's unique ID |
| `this.ctx.exports` | `object` | Loopback to Worker's own exports |

### Methods

```ts
// Block all requests until callback completes (use in constructor for migrations)
this.ctx.blockConcurrencyWhile(callback: () => Promise<T>): Promise<T>

// WebSocket Hibernation — accept a WebSocket for hibernation support
this.ctx.acceptWebSocket(ws: WebSocket, tags?: string[]): void

// Get all accepted WebSockets (optionally filtered by tag)
this.ctx.getWebSockets(tag?: string): WebSocket[]

// Set auto-response for pings during hibernation (avoids waking the DO)
this.ctx.setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void

// Get timestamp of last auto-response for a WebSocket
this.ctx.getWebSocketAutoResponseTimestamp(ws: WebSocket): Date | null

// Set max duration for WebSocket event handlers
this.ctx.setHibernatableWebSocketEventTimeout(timeoutMs?: number): void

// Extend request lifetime (like waitUntil on Workers)
this.ctx.waitUntil(promise: Promise<unknown>): void

// Abort the DO — resets in-memory state, re-runs constructor on next request
this.ctx.abort(reason?: string): never
```

---

## SQLite Storage API

Available on `this.ctx.storage.sql` for SQLite-backed DOs.

### sql.exec()

```ts
// Basic query
this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, val TEXT)");

// Parameterized query (use ? placeholders)
this.ctx.storage.sql.exec(
  "INSERT INTO items (id, val) VALUES (?, ?)",
  itemId, itemValue
);

// Typed query → returns a cursor
const cursor = this.ctx.storage.sql.exec<{ id: string; val: string }>(
  "SELECT id, val FROM items WHERE id = ?", itemId
);

// Cursor methods
cursor.toArray();        // Consume all rows into an array
cursor.one();            // Get exactly one row (throws if 0 or 2+)
cursor.raw();            // Iterator of raw value arrays (no column names)
cursor.columnNames;      // string[] of column names
cursor.rowsRead;         // Number of rows scanned
cursor.rowsWritten;      // Number of rows modified

// Iterate directly
for (const row of cursor) {
  console.log(row.id, row.val);
}
```

### Column Types

SQLite values map to TypeScript as: `string | number | ArrayBuffer | null` (`SqlStorageValue`).

### sql.databaseSize

```ts
const sizeInBytes: number = this.ctx.storage.sql.databaseSize;
```

### Transactions

SQLite operations within a single `sql.exec()` call are atomic. For multi-statement transactions, use `BEGIN`/`COMMIT`:

```ts
this.ctx.storage.sql.exec("BEGIN");
try {
  this.ctx.storage.sql.exec("UPDATE accounts SET balance = balance - ? WHERE id = ?", amount, fromId);
  this.ctx.storage.sql.exec("UPDATE accounts SET balance = balance + ? WHERE id = ?", amount, toId);
  this.ctx.storage.sql.exec("COMMIT");
} catch (e) {
  this.ctx.storage.sql.exec("ROLLBACK");
  throw e;
}
```

Note: SQLite operations are **synchronous** and do not yield the event loop. They complete atomically without risk of interleaving.

---

## KV Storage API (Legacy)

Available on `this.ctx.storage` for both SQLite-backed and KV-backed DOs.

### Async KV Methods

```ts
// Get
await this.ctx.storage.get<T>(key: string): Promise<T | undefined>
await this.ctx.storage.get<T>(keys: string[]): Promise<Map<string, T>>

// Put
await this.ctx.storage.put<T>(key: string, value: T): Promise<void>
await this.ctx.storage.put<T>(entries: Record<string, T>): Promise<void>

// Delete
await this.ctx.storage.delete(key: string): Promise<boolean>
await this.ctx.storage.delete(keys: string[]): Promise<number>

// Delete ALL storage (including SQL tables, metadata, alarms)
await this.ctx.storage.deleteAll(): Promise<void>

// List (with optional prefix, reverse, limit, cursor)
await this.ctx.storage.list<T>(options?: {
  prefix?: string;
  reverse?: boolean;
  limit?: number;
  start?: string;        // Inclusive start key
  startAfter?: string;   // Exclusive start key
  end?: string;           // Exclusive end key
}): Promise<Map<string, T>>
```

### Sync KV Methods (SQLite-backed DOs only)

```ts
this.ctx.storage.getSync<T>(key: string): T | undefined
this.ctx.storage.putSync<T>(key: string, value: T): void
this.ctx.storage.deleteSync(key: string): boolean
this.ctx.storage.listSync<T>(options?): Map<string, T>
```

### Transaction (KV only)

```ts
await this.ctx.storage.transaction<T>(callback: (txn: DurableObjectTransaction) => Promise<T>): Promise<T>
```

Provides a transactional wrapper. Writes are committed atomically or rolled back on error.

---

## Alarms API

Each DO can have **one** active alarm. Setting a new alarm replaces the previous one.

```ts
// Set alarm
await this.ctx.storage.setAlarm(scheduledTime: number | Date): Promise<void>

// Get current alarm
await this.ctx.storage.getAlarm(): Promise<number | null>  // Returns epoch ms or null

// Delete alarm
await this.ctx.storage.deleteAlarm(): Promise<void>
```

### Alarm Handler

```ts
export class MyDO extends DurableObject {
  async alarm(): Promise<void> {
    // Called when the alarm fires
    // `this` has isRetry property in the alarm event context

    // For recurring alarms, re-set at the end:
    await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
}
```

**Alarm behavior:**
- Fires even if the DO is hibernating (wakes it up).
- Retried automatically on failure (up to 6 attempts with backoff).
- `alarm()` receives no arguments. Check `this.ctx.storage` for context.
- If the DO is deleted while an alarm is pending, the alarm is cancelled.

---

## DurableObjectNamespace (Bindings)

The namespace binding (e.g., `env.MY_DO`) provides methods to get stubs:

```ts
interface DurableObjectNamespace<T extends DurableObject> {
  // Get a stub by ID
  get(id: DurableObjectId): DurableObjectStub<T>;

  // Get a stub by name (deterministic, preferred)
  getByName(name: string): DurableObjectStub<T>;

  // Create a deterministic ID from a name
  idFromName(name: string): DurableObjectId;

  // Create a random unique ID
  newUniqueId(options?: { jurisdiction?: "eu" }): DurableObjectId;

  // Reconstruct an ID from its string form
  idFromString(hexString: string): DurableObjectId;
}
```

### getByName() vs idFromName() + get()

```ts
// These are equivalent:
const stub = env.MY_DO.getByName("room-123");
// vs
const id = env.MY_DO.idFromName("room-123");
const stub = env.MY_DO.get(id);
```

`getByName()` is shorthand. Use `idFromName()` + `get()` when you need the ID object (e.g., to store it or pass it around).

---

## DurableObjectId

```ts
interface DurableObjectId {
  toString(): string;   // Hex string representation
  equals(other: DurableObjectId): boolean;
  name?: string;        // The name if created via idFromName/getByName
}
```

---

## DurableObjectStub

A stub is a proxy to a remote DO instance. Call RPC methods on it:

```ts
const stub = env.MY_DO.getByName("room-123");

// RPC calls (preferred — requires compatibility_date >= 2024-04-03)
const result = await stub.myMethod(arg1, arg2);

// HTTP fetch (legacy)
const response = await stub.fetch(new Request("https://fake-host/path"));
```

**Creating a stub does NOT instantiate the DO.** The DO is only activated when you call a method on it.

---

## RPC Methods

Any public method on your DO class (that isn't a reserved handler) is callable via RPC from stubs. Requires `compatibility_date >= 2024-04-03`.

```ts
export class MyDO extends DurableObject<Env> {
  // ✅ RPC method — callable from stub
  async getCount(): Promise<number> { /* ... */ }

  // ✅ RPC method with args
  async setItem(key: string, value: string): Promise<void> { /* ... */ }

  // ❌ Reserved — NOT RPC (alarm handler)
  async alarm(): Promise<void> { /* ... */ }

  // ❌ Reserved — NOT RPC (fetch handler)
  async fetch(request: Request): Promise<Response> { /* ... */ }

  // ❌ Reserved — NOT RPC (WebSocket handlers)
  async webSocketMessage(ws: WebSocket, msg: string): Promise<void> { /* ... */ }
}
```

### RPC Type Safety

TypeScript provides full type checking on stub method calls:

```ts
// The stub type matches the DO class
const stub: DurableObjectStub<MyDO> = env.MY_DO.getByName("x");
const count: number = await stub.getCount();       // ✅ Typed
await stub.setItem("key", "value");                 // ✅ Typed
await stub.nonExistent();                           // ❌ TypeScript error
```

### RPC Serialization

RPC arguments and return values are serialized via the [structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm). This supports objects, arrays, Maps, Sets, Dates, ArrayBuffers, Errors, RegExps, and more — but NOT functions, DOM nodes, or class instances with prototypes.

---

## fetch() Handler (Legacy)

For compatibility or HTTP-specific use cases:

```ts
export class MyDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      // WebSocket upgrade
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/data") {
      const data = await this.ctx.storage.get("data");
      return Response.json(data);
    }

    return new Response("Not found", { status: 404 });
  }
}
```

**Prefer RPC methods** for all non-HTTP use cases. Use `fetch()` only for WebSocket upgrades or when you need HTTP request/response semantics.

---

## Input and Output Gates

Cloudflare's runtime has built-in concurrency control to prevent data races in Durable Objects:

### Input Gates

While an async KV storage operation (`get`, `put`, `delete`, `list`) is in progress, other requests are **blocked from entering** the DO. This prevents a second request from reading stale data while a first request is in the middle of a read-modify-write.

SQLite operations are **synchronous** and don't yield the event loop, so input gates don't apply — they're inherently atomic.

### Output Gates

After a storage write, the DO waits for the write to be confirmed durable before allowing the response to be sent back to the caller. This ensures that if a client receives a response, the data is definitely persisted.

### Implications

- KV storage calls serialize concurrent requests automatically.
- SQLite calls don't yield, so they don't introduce interleaving.
- External `fetch()` calls DO yield the event loop, allowing other requests to interleave. If this is problematic, use `blockConcurrencyWhile()`.

---

## blockConcurrencyWhile()

Blocks ALL incoming requests until the callback completes:

```ts
this.ctx.blockConcurrencyWhile(async () => {
  // No other requests can run during this block
  const config = await fetch("https://api.example.com/config").then(r => r.json());
  this.ctx.storage.sql.exec("INSERT INTO config (data) VALUES (?)", JSON.stringify(config));
});
```

**Use sparingly:**
- In the constructor for migrations and initialization.
- When external `fetch()` calls must not be interleaved with other requests.
- NOT needed for SQLite operations (they're synchronous).
- NOT needed for KV operations (input gates handle it).

---

## Point-in-Time Recovery

SQLite-backed DOs support restoring to any point in the past 30 days:

```ts
// Get current bookmark
const bookmark: string = await this.ctx.storage.getCurrentBookmark();

// Get bookmark at a specific time
const pastBookmark: string = await this.ctx.storage.getBookmarkForTime(timestamp: number);

// Restore to a bookmark (WARNING: destructive — replaces current state)
await this.ctx.storage.onNextSessionRestoreBookmark(bookmark: string): Promise<void>;
// The DO will restart and restore on the next session
```

---

## Location Hints

Influence where a DO is created (suggestion, not guarantee):

```ts
const id = env.MY_DO.idFromName("room-123");
const stub = env.MY_DO.get(id, { locationHint: "enam" }); // Eastern North America

// Available hints: wnam, enam, sam, weur, eeur, apac, oc, afr, me
```

Location hints only matter at creation time. Once a DO exists, it stays in its original location.
