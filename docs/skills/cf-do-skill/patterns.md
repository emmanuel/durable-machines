# Durable Objects Common Patterns

## Table of Contents

1. [Counter](#counter)
2. [Rate Limiter](#rate-limiter)
3. [Chat Room (WebSocket)](#chat-room-websocket)
4. [Game Session](#game-session)
5. [Parent-Child Hierarchy](#parent-child-hierarchy)
6. [Per-User Storage](#per-user-storage)
7. [TTL / Self-Destructing Object](#ttl--self-destructing-object)
8. [Periodic Polling](#periodic-polling)
9. [Distributed Lock](#distributed-lock)
10. [Event Sourcing](#event-sourcing)
11. [Collaborative Document](#collaborative-document)

---

## Counter

The simplest Durable Object — atomic increment/decrement with SQLite storage.

```ts
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject<Env> {
  async increment(amount = 1): Promise<number> {
    this.ctx.storage.sql.exec(
      "INSERT INTO counter (id, value) VALUES ('count', ?) ON CONFLICT(id) DO UPDATE SET value = value + ?",
      amount, amount
    );
    return this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM counter WHERE id = 'count'").one().value;
  }

  async decrement(amount = 1): Promise<number> {
    return this.increment(-amount);
  }

  async get(): Promise<number> {
    const rows = this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM counter WHERE id = 'count'").toArray();
    return rows[0]?.value ?? 0;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counter (id TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)");
    });
  }
}

// Worker
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const counterName = url.searchParams.get("name") ?? "default";
    const stub = env.COUNTERS.getByName(counterName);

    switch (url.pathname) {
      case "/increment": return Response.json({ value: await stub.increment() });
      case "/decrement": return Response.json({ value: await stub.decrement() });
      case "/": return Response.json({ value: await stub.get() });
      default: return new Response("Not found", { status: 404 });
    }
  },
};
```

---

## Rate Limiter

Use one DO per client/IP to enforce rate limits with a sliding window.

```ts
export class RateLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS requests (
          timestamp INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_ts ON requests(timestamp)");
    });
  }

  async checkLimit(maxRequests: number, windowMs: number): Promise<{ allowed: boolean; remaining: number }> {
    const now = Date.now();
    const windowStart = now - windowMs;

    // Clean old entries
    this.ctx.storage.sql.exec("DELETE FROM requests WHERE timestamp < ?", windowStart);

    // Count current window
    const count = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT COUNT(*) as c FROM requests WHERE timestamp >= ?", windowStart)
      .one().c;

    if (count >= maxRequests) {
      return { allowed: false, remaining: 0 };
    }

    // Record this request
    this.ctx.storage.sql.exec("INSERT INTO requests (timestamp) VALUES (?)", now);
    return { allowed: true, remaining: maxRequests - count - 1 };
  }
}

// Worker
export default {
  async fetch(request: Request, env: Env) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const limiter = env.RATE_LIMITER.getByName(ip);
    const { allowed, remaining } = await limiter.checkLimit(100, 60000); // 100 req/min

    if (!allowed) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "X-RateLimit-Remaining": "0", "Retry-After": "60" },
      });
    }

    // Process request normally
    return new Response("OK", {
      headers: { "X-RateLimit-Remaining": String(remaining) },
    });
  },
};
```

---

## Chat Room (WebSocket)

A chat room using Hibernatable WebSockets for cost efficiency.

```ts
export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    });
  }

  // Called from Worker to upgrade to WebSocket
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("Not found", { status: 404 });

    const pair = new WebSocketPair();
    const userId = url.searchParams.get("userId") ?? "anon";

    // Accept with Hibernation API (allows DO to sleep with connections open)
    this.ctx.acceptWebSocket(pair[1], [userId]);

    // Attach user metadata (survives hibernation)
    pair[1].serializeAttachment({ userId, joinedAt: Date.now() });

    // Send recent history
    const history = this.ctx.storage.sql
      .exec<{ user_id: string; content: string; created_at: number }>(
        "SELECT user_id, content, created_at FROM messages ORDER BY id DESC LIMIT 50"
      ).toArray().reverse();
    pair[1].send(JSON.stringify({ type: "history", messages: history }));

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // WebSocket message handler (Hibernation API)
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const data = JSON.parse(message);
    const attachment = ws.deserializeAttachment() as { userId: string };

    if (data.type === "message") {
      // Persist message
      this.ctx.storage.sql.exec(
        "INSERT INTO messages (user_id, content, created_at) VALUES (?, ?, ?)",
        attachment.userId, data.content, Date.now()
      );

      // Broadcast to all connected clients
      const broadcast = JSON.stringify({
        type: "message",
        userId: attachment.userId,
        content: data.content,
        timestamp: Date.now(),
      });

      for (const client of this.ctx.getWebSockets()) {
        try { client.send(broadcast); } catch { /* client disconnected */ }
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  // RPC method for getting room stats without WebSocket
  async getStats(): Promise<{ connections: number; messageCount: number }> {
    const connections = this.ctx.getWebSockets().length;
    const messageCount = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT COUNT(*) as c FROM messages")
      .one().c;
    return { connections, messageCount };
  }
}
```

---

## Game Session

One DO per match. Manages players, game state, turns, and timeouts via alarms.

```ts
export class GameSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, name TEXT, score INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
      `);
    });
  }

  async join(playerId: string, name: string): Promise<{ players: any[] }> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO players (id, name, score) VALUES (?, ?, 0)",
      playerId, name
    );
    return { players: this.ctx.storage.sql.exec("SELECT * FROM players").toArray() };
  }

  async submitMove(playerId: string, move: any): Promise<{ valid: boolean; state: any }> {
    // Validate and apply game logic
    const currentTurn = this.getState("currentTurn");
    if (currentTurn !== playerId) return { valid: false, state: null };

    // Apply move, update state, advance turn
    this.setState("lastMove", JSON.stringify(move));
    this.advanceTurn();

    // Set turn timeout (30 seconds)
    await this.ctx.storage.setAlarm(Date.now() + 30000);

    return { valid: true, state: this.getFullState() };
  }

  async alarm(): Promise<void> {
    // Turn timeout — auto-skip the current player
    this.advanceTurn();
  }

  private getState(key: string): string | null {
    const rows = this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM state WHERE key = ?", key
    ).toArray();
    return rows[0]?.value ?? null;
  }

  private setState(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)", key, value
    );
  }

  private advanceTurn(): void {
    const players = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM players ORDER BY id").toArray();
    const current = this.getState("currentTurn");
    const idx = players.findIndex(p => p.id === current);
    const next = players[(idx + 1) % players.length]?.id ?? players[0]?.id;
    this.setState("currentTurn", next);
  }

  private getFullState(): any {
    return {
      players: this.ctx.storage.sql.exec("SELECT * FROM players").toArray(),
      currentTurn: this.getState("currentTurn"),
      lastMove: this.getState("lastMove"),
    };
  }
}
```

---

## Parent-Child Hierarchy

A parent DO tracks child DOs. Children handle their own state independently.

```ts
// Parent: Workspace (tracks projects)
export class Workspace extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    });
  }

  async createProject(name: string): Promise<string> {
    const projectId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)",
      projectId, name, Date.now()
    );

    // Initialize child DO
    const childStub = this.env.PROJECT.getByName(projectId);
    await childStub.init(projectId, name);

    return projectId;
  }

  async listProjects(): Promise<{ id: string; name: string }[]> {
    return this.ctx.storage.sql.exec<{ id: string; name: string }>(
      "SELECT id, name FROM projects ORDER BY created_at DESC"
    ).toArray();
  }

  async deleteProject(projectId: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM projects WHERE id = ?", projectId);
    const childStub = this.env.PROJECT.getByName(projectId);
    await childStub.destroy();
  }
}

// Child: Project (manages its own tasks)
export class Project extends DurableObject<Env> {
  async init(projectId: string, name: string): Promise<void> {
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0);
      `);
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('name', ?)", name);
    });
  }

  async addTask(title: string): Promise<string> {
    const taskId = crypto.randomUUID();
    this.ctx.storage.sql.exec("INSERT INTO tasks (id, title) VALUES (?, ?)", taskId, title);
    return taskId;
  }

  async completeTask(taskId: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE tasks SET done = 1 WHERE id = ?", taskId);
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
```

---

## Per-User Storage

One DO per user for isolated, per-user data.

```ts
export class UserData extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, ts INTEGER);
      `);
    });
  }

  async setPreference(key: string, value: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)", key, value
    );
  }

  async getPreferences(): Promise<Record<string, string>> {
    const rows = this.ctx.storage.sql.exec<{ key: string; value: string }>(
      "SELECT key, value FROM preferences"
    ).toArray();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }

  async logActivity(action: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO activity (action, ts) VALUES (?, ?)", action, Date.now());
    // Keep only last 1000 entries
    this.ctx.storage.sql.exec(`
      DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 1000)
    `);
  }
}

// Worker routes by authenticated user ID
export default {
  async fetch(request: Request, env: Env) {
    const userId = await authenticateUser(request); // Your auth logic
    const userData = env.USER_DATA.getByName(userId);
    // ...
  },
};
```

---

## TTL / Self-Destructing Object

Use alarms to auto-delete a DO after a period of inactivity.

```ts
export class TempSession extends DurableObject<Env> {
  private readonly TTL_MS = 3600000; // 1 hour

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS data (key TEXT PRIMARY KEY, value TEXT)");
    });
  }

  async touch(): Promise<void> {
    // Reset the TTL alarm on every interaction
    await this.ctx.storage.setAlarm(Date.now() + this.TTL_MS);
  }

  async set(key: string, value: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO data (key, value) VALUES (?, ?)", key, value);
    await this.touch();
  }

  async get(key: string): Promise<string | null> {
    await this.touch();
    const rows = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM data WHERE key = ?", key).toArray();
    return rows[0]?.value ?? null;
  }

  async alarm(): Promise<void> {
    // TTL expired — clean up all storage
    await this.ctx.storage.deleteAll();
  }
}
```

---

## Periodic Polling

Use alarms to periodically fetch data from an external API.

```ts
export class PollMonitor extends DurableObject<Env> {
  private readonly POLL_INTERVAL_MS = 60000; // 1 minute

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT, ts INTEGER);
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
      `);
    });
  }

  async startPolling(url: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO config (key, value) VALUES ('url', ?)", url);
    await this.ctx.storage.setAlarm(Date.now() + this.POLL_INTERVAL_MS);
  }

  async stopPolling(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM config WHERE key = 'url'"
    ).toArray();
    const url = rows[0]?.value;
    if (!url) return;

    try {
      const response = await fetch(url);
      const data = await response.text();
      this.ctx.storage.sql.exec(
        "INSERT INTO snapshots (data, ts) VALUES (?, ?)", data, Date.now()
      );
      // Keep last 100 snapshots
      this.ctx.storage.sql.exec(`
        DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 100)
      `);
    } catch (e) {
      // Log error, continue polling
    }

    // Re-arm alarm
    await this.ctx.storage.setAlarm(Date.now() + this.POLL_INTERVAL_MS);
  }

  async getSnapshots(limit = 10): Promise<any[]> {
    return this.ctx.storage.sql.exec<{ data: string; ts: number }>(
      "SELECT data, ts FROM snapshots ORDER BY id DESC LIMIT ?", limit
    ).toArray();
  }
}
```

---

## Distributed Lock

A DO naturally acts as a distributed lock — only one request runs at a time.

```ts
export class DistributedLock extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS locks (
          resource TEXT PRIMARY KEY,
          holder TEXT NOT NULL,
          acquired_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
    });
  }

  async acquire(resource: string, holder: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    // Clean expired locks
    this.ctx.storage.sql.exec("DELETE FROM locks WHERE expires_at < ?", now);

    // Check if already locked
    const existing = this.ctx.storage.sql
      .exec<{ holder: string }>("SELECT holder FROM locks WHERE resource = ?", resource)
      .toArray();

    if (existing.length > 0) return false;

    // Acquire
    this.ctx.storage.sql.exec(
      "INSERT INTO locks (resource, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)",
      resource, holder, now, now + ttlMs
    );
    return true;
  }

  async release(resource: string, holder: string): Promise<boolean> {
    const rows = this.ctx.storage.sql
      .exec<{ holder: string }>("SELECT holder FROM locks WHERE resource = ?", resource)
      .toArray();
    if (rows[0]?.holder !== holder) return false;

    this.ctx.storage.sql.exec("DELETE FROM locks WHERE resource = ? AND holder = ?", resource, holder);
    return true;
  }
}
```

---

## Event Sourcing

Store all events, derive state from the event log.

```ts
export class EventSourcedEntity extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          ts INTEGER NOT NULL
        )
      `);
    });
  }

  async appendEvent(type: string, data: Record<string, unknown>): Promise<number> {
    this.ctx.storage.sql.exec(
      "INSERT INTO events (type, data, ts) VALUES (?, ?, ?)",
      type, JSON.stringify(data), Date.now()
    );
    return this.ctx.storage.sql.exec<{ seq: number }>(
      "SELECT last_insert_rowid() as seq"
    ).one().seq;
  }

  async getEvents(sinceSeq = 0): Promise<Array<{ seq: number; type: string; data: any; ts: number }>> {
    return this.ctx.storage.sql
      .exec<{ seq: number; type: string; data: string; ts: number }>(
        "SELECT seq, type, data, ts FROM events WHERE seq > ? ORDER BY seq", sinceSeq
      )
      .toArray()
      .map(e => ({ ...e, data: JSON.parse(e.data) }));
  }

  async getCurrentState(): Promise<any> {
    const events = await this.getEvents();
    return events.reduce((state, event) => applyEvent(state, event), {});
  }
}

function applyEvent(state: any, event: { type: string; data: any }): any {
  switch (event.type) {
    case "created": return { ...state, ...event.data };
    case "updated": return { ...state, ...event.data };
    case "deleted": return { ...state, deleted: true };
    default: return state;
  }
}
```
