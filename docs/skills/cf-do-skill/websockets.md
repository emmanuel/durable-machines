# Durable Objects WebSocket Guide

## Table of Contents

1. [Hibernatable WebSocket API (Recommended)](#hibernatable-websocket-api-recommended)
2. [Connection Lifecycle](#connection-lifecycle)
3. [serializeAttachment / deserializeAttachment](#serializeattachment--deserializeattachment)
4. [Auto-Response (Ping/Pong)](#auto-response-pingpong)
5. [Broadcasting to All Clients](#broadcasting-to-all-clients)
6. [WebSocket Tags](#websocket-tags)
7. [Web Standard WebSocket API (Legacy)](#web-standard-websocket-api-legacy)
8. [Cost Optimization](#cost-optimization)
9. [Performance Tips](#performance-tips)

---

## Hibernatable WebSocket API (Recommended)

The Hibernation API allows Durable Objects to sleep while maintaining WebSocket connections, dramatically reducing costs. When a message arrives, the DO wakes up, processes it, and can go back to sleep.

### Accepting a WebSocket

```ts
export class MyDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    // Create a WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = pair;

    // Accept with Hibernation API (NOT ws.accept())
    this.ctx.acceptWebSocket(server, ["optional-tag"]);

    // Return client end to the caller
    return new Response(null, { status: 101, webSocket: client });
  }
}
```

**Critical:** Use `this.ctx.acceptWebSocket(ws)`, NOT `ws.accept()`. The standard `ws.accept()` prevents hibernation.

### Handler Methods

```ts
export class MyDO extends DurableObject<Env> {
  // Called when a connected WebSocket sends a message
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") {
      const data = JSON.parse(message);
      // Process message
      ws.send(JSON.stringify({ type: "ack", id: data.id }));
    }
  }

  // Called when a WebSocket connection is closed
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // MUST call ws.close() to complete the handshake
    ws.close(code, reason);
  }

  // Called when a WebSocket error occurs
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error:", error);
    ws.close(1011, "Internal error");
  }
}
```

### Getting Connected WebSockets

```ts
// Get all connected WebSockets
const allSockets: WebSocket[] = this.ctx.getWebSockets();

// Get WebSockets with a specific tag
const adminSockets: WebSocket[] = this.ctx.getWebSockets("admin");
```

---

## Connection Lifecycle

1. **Client sends HTTP upgrade request** to the Worker.
2. **Worker routes to DO** via stub (can use `fetch()` or set up upgrade in the Worker and pass to DO).
3. **DO creates `WebSocketPair`**, calls `this.ctx.acceptWebSocket(server)`, returns client.
4. **Messages flow** — `webSocketMessage()` fires on each message.
5. **DO hibernates** when idle (no messages, no alarms, no pending I/O).
6. **DO wakes** when a message arrives, constructor re-runs, `webSocketMessage()` fires.
7. **Connection closes** — `webSocketClose()` fires, call `ws.close()` to complete handshake.

### What Survives Hibernation

| Survives | Lost |
|---|---|
| WebSocket connections | In-memory instance variables |
| `serializeAttachment()` data | setTimeout/setInterval callbacks |
| SQLite/KV storage | Pending fetch() calls |
| Alarms | Cached data in instance fields |

After hibernation, the **constructor re-runs**. Minimize constructor work when using WebSockets.

---

## serializeAttachment / deserializeAttachment

Persist small data per WebSocket connection. This data survives hibernation.

```ts
// When accepting the connection
this.ctx.acceptWebSocket(server);
server.serializeAttachment({
  userId: "user-123",
  username: "Alice",
  joinedAt: Date.now(),
  role: "admin",
});

// Later, in a handler
async webSocketMessage(ws: WebSocket, message: string) {
  const attachment = ws.deserializeAttachment() as {
    userId: string;
    username: string;
    role: string;
  };

  console.log(`Message from ${attachment.username}: ${message}`);

  // Update attachment
  ws.serializeAttachment({
    ...attachment,
    lastMessageAt: Date.now(),
  });
}
```

**Limits:** Attachments should be small (a few KB). For large data, store in SQLite and keep a key in the attachment.

---

## Auto-Response (Ping/Pong)

Set automatic responses to keep connections alive without waking the DO.

```ts
// Set auto-response for all accepted WebSockets
this.ctx.setWebSocketAutoResponse(
  new WebSocketRequestResponsePair("ping", "pong")
);

// When any client sends "ping", the runtime responds with "pong"
// WITHOUT waking the Durable Object — no billable duration charges.

// Check when a specific WebSocket last got an auto-response
const lastPong: Date | null = this.ctx.getWebSocketAutoResponseTimestamp(ws);

// Clear auto-response
this.ctx.setWebSocketAutoResponse(); // Pass nothing to clear
```

This is ideal for keepalive pings. The client sends "ping" periodically, and the runtime responds automatically without incurring compute costs.

---

## Broadcasting to All Clients

```ts
async broadcast(message: string, excludeWs?: WebSocket): void {
  const sockets = this.ctx.getWebSockets();
  for (const ws of sockets) {
    if (ws === excludeWs) continue;
    try {
      ws.send(message);
    } catch {
      // Client disconnected — will be cleaned up on next webSocketClose
    }
  }
}

// Usage in a handler
async webSocketMessage(ws: WebSocket, message: string) {
  // Broadcast to everyone except the sender
  this.broadcast(JSON.stringify({ type: "chat", content: message }), ws);
}
```

---

## WebSocket Tags

Tags help you categorize and filter connections:

```ts
// Accept with tags
this.ctx.acceptWebSocket(server, ["room:lobby", "role:admin"]);

// Get connections by tag
const lobbyClients = this.ctx.getWebSockets("room:lobby");
const admins = this.ctx.getWebSockets("role:admin");

// Broadcast to a specific group
for (const ws of this.ctx.getWebSockets("room:lobby")) {
  ws.send(JSON.stringify({ type: "room_message", content: "Hello lobby!" }));
}
```

Tags are set once on `acceptWebSocket()` and cannot be changed afterward. To "move" a connection to a different group, track the mapping in storage or attachments.

---

## Web Standard WebSocket API (Legacy)

**Avoid this for new code** — it prevents hibernation.

```ts
export class MyDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();

    // ❌ Legacy: prevents hibernation
    pair[1].accept();

    pair[1].addEventListener("message", (event) => {
      pair[1].send(`Echo: ${event.data}`);
    });

    pair[1].addEventListener("close", (event) => {
      console.log("Closed:", event.code, event.reason);
    });

    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
```

**Why avoid:** Using `ws.accept()` and `addEventListener` means the DO cannot hibernate while connections are open. You pay for wall-clock duration the entire time any client is connected.

---

## Cost Optimization

### Hibernation Savings

| API | Connection idle for 1 hour | Cost |
|---|---|---|
| Standard (`ws.accept()`) | DO runs for 1 hour | ~$0.015 per hour |
| Hibernation (`ctx.acceptWebSocket()`) | DO sleeps, wakes only for messages | ~$0 while idle |

For a chat room with 100 users where messages arrive every few seconds, hibernation can reduce duration charges by 90%+ during quiet periods.

### Best Practices

1. **Always use Hibernatable WebSocket API** (`this.ctx.acceptWebSocket()`).
2. **Use auto-response** for keepalive pings to avoid waking the DO.
3. **Batch messages** when possible — 10 messages in one frame vs. 10 separate frames reduces context switch overhead.
4. **Keep constructor lightweight** — it re-runs on every wake from hibernation.
5. **Store per-connection state in attachments**, not in-memory maps.
6. **Set `setHibernatableWebSocketEventTimeout()`** to prevent runaway handlers.

---

## Performance Tips

### Message Batching

Each WebSocket message incurs overhead from context switches. Batching reduces this:

```ts
// ❌ Many small messages
for (const update of updates) {
  ws.send(JSON.stringify(update));
}

// ✅ Batch into one message
ws.send(JSON.stringify({ type: "batch", updates }));
```

### Connection Limits

A single DO can handle thousands of WebSocket connections. The practical limit depends on message frequency and processing complexity. For very high throughput, shard across multiple DOs (e.g., one per region or per group).

### Binary Messages

Use `ArrayBuffer` for binary data (game state, media, compressed data):

```ts
async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
  if (message instanceof ArrayBuffer) {
    // Process binary data
    const view = new Uint8Array(message);
    // ...
  }
}
```
