# Plan: Security Hardening

## Status: In Progress

Full-stack remediation of vulnerabilities identified through security audit of the
gateway, worker, durable-machine, and dashboard packages. Organized into eight
work streams, each independently shippable. Phases are ordered by blast radius —
earlier phases block production readiness; later phases are defense-in-depth.

### Completed

| Phase | What shipped | Commit |
|-------|-------------|--------|
| 1 | Request body limits (1 MB cap in `rawBody()`) | `c05e608` |
| 4 | Action link replay protection (timestamped HMAC, 24h expiry, legacy mode removed) | `c05e608`, current |
| 6 (partial) | Pluggable `GatewaySecurityOptions` (`restAuth`, `dashboardAuth`), SSE connection limits | `c05e608` |
| 8 (partial) | `ID_PATTERN` validation, status filter allowlist, event log pagination with bounds checking, NOTIFY payload validation | `c05e608` |
| — | Shorthand routes removed (bypassed `ID_PATTERN` validation) | current |
| — | `restShorthand` option removed from `RestApiOptions` and `GatewayContextOptions` | current |
| 2 | NaN timestamp checks (already had `Number.isNaN`); Linear type-confusion bypass fixed (`typeof !== "number"` guard) | current |
| 3 | Timing side-channels: all HMAC sources use `verifyHmac()`; xAPI basic auth padded to constant-time (`constantTimeCompare`) | current |
| 5 | Email header injection: `sanitizeSubject` extended to strip `\0`, `\u2028`, `\u2029` | current |

---

## Phase 1: Request Body Limits and DoS Prevention ✅

### Problem

`rawBody()` middleware reads the entire request body into memory with no size cap.
A single multi-GB POST exhausts server memory.

### Changes

**`packages/gateway/src/middleware.ts`**

Add a `maxBodyBytes` parameter (default 1 MB) to `rawBody()`. Read the stream
incrementally and abort with 413 if the limit is exceeded:

```typescript
export function rawBody(opts?: { maxBodyBytes?: number }) {
  const limit = opts?.maxBodyBytes ?? 1_048_576; // 1 MB
  return createMiddleware<RawBodyEnv>(async (c, next) => {
    const reader = c.req.raw.body?.getReader();
    if (!reader) { c.set("rawBody", ""); return next(); }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        reader.cancel();
        return c.json({ error: "Payload too large" }, 413);
      }
      chunks.push(value);
    }
    c.set("rawBody", Buffer.concat(chunks).toString("utf-8"));
    await next();
  });
}
```

**`packages/gateway/src/gateway.ts:109`** — Pass configurable limit:

```typescript
app.post(path, rawBody({ maxBodyBytes: options.maxBodyBytes }), async (c) => { ... });
```

**`packages/durable-machine/src/pg/store.ts:188-201`** — Add event payload size
validation before `JSON.stringify`:

```typescript
async function appendEvent(instanceId, event, source?) {
  const json = JSON.stringify(event);
  if (json.length > MAX_EVENT_PAYLOAD_BYTES) {
    throw new DurableMachineError("Event payload exceeds size limit", "VALIDATION");
  }
  // ... existing query
}
```

Add `MAX_EVENT_PAYLOAD_BYTES = 256 * 1024` (256 KB) as a module constant.

### Tests

- Unit test: `rawBody()` returns 413 for oversized payload.
- Unit test: `appendEvent()` rejects payloads above the limit.

---

## Phase 2: Fix Timestamp Validation Bypasses ✅

### Problem

Stripe and Slack sources use `parseInt()` on timestamp headers without NaN checking.
Non-numeric values produce `NaN`, and `Math.abs(now - NaN) > MAX` evaluates to
`false`, silently disabling replay protection.

Linear makes `webhookTimestamp` optional — omitting it bypasses the replay window.

### Changes

**`packages/gateway/src/sources/stripe.ts:42-46`**

```typescript
const ts = parseInt(timestamp, 10);
if (Number.isNaN(ts)) {
  throw new WebhookVerificationError("Invalid timestamp", "stripe");
}
const now = Math.floor(Date.now() / 1000);
if (Math.abs(now - ts) > MAX_TIMESTAMP_AGE_S) {
  throw new WebhookVerificationError("Timestamp too old", "stripe");
}
```

**`packages/gateway/src/sources/slack.ts:30-33`** — Same NaN guard.

**`packages/gateway/src/sources/slack-slash.ts:74-77`** — Same NaN guard.

**`packages/gateway/src/sources/linear.ts:30-37`** — Make timestamp required:

```typescript
const body = JSON.parse(req.body) as { webhookTimestamp?: number };
if (body.webhookTimestamp == null) {
  throw new WebhookVerificationError("Missing webhookTimestamp in body", "linear");
}
const now = Date.now();
if (Math.abs(now - body.webhookTimestamp) > MAX_TIMESTAMP_AGE_S * 1000) {
  throw new WebhookVerificationError("Timestamp too old", "linear");
}
```

### Tests

- For each source: test that non-numeric timestamp header → 401.
- For Linear: test that missing `webhookTimestamp` → 401.

---

## Phase 3: Fix Timing Side-Channels in Signature Verification ✅

### Problem

Slack, Stripe, and Twilio sources check `Buffer.length` equality before calling
`timingSafeEqual()`, creating an early-exit fast path that leaks signature length.
The xAPI basic-auth comparison has the same pattern.

### Changes

The fix is the same for all affected sources: use a constant-time comparison that
handles length mismatches without early exit.

**`packages/gateway/src/hmac.ts`** — Already correct (line 41 combines length check
with `timingSafeEqual` in a single `||` expression). This is the canonical pattern.

**`packages/gateway/src/sources/stripe.ts:55-62`** — Combine into single check:

```typescript
if (
  expectedBuf.length !== computedBuf.length ||
  !timingSafeEqual(expectedBuf, computedBuf)
) {
  throw new WebhookVerificationError("Signature mismatch", "stripe");
}
```

Note: `hmac.ts` already does this correctly. The issue is that Stripe/Slack/Twilio
sources duplicate the HMAC logic inline instead of delegating to `verifyHmac()`.
The real fix is to **refactor these sources to use `verifyHmac()`** from `hmac.ts`,
eliminating the duplicated comparison code entirely.

**`packages/gateway/src/sources/slack.ts:41-51`** — Replace inline comparison with:

```typescript
verifyHmac("sha256", signingSecret, basestring, expected, "slack");
```

**`packages/gateway/src/sources/stripe.ts:52-62`** — Replace with:

```typescript
verifyHmac("sha256", webhookSecret, signedPayload, v1Signature, "stripe");
```

**`packages/gateway/src/sources/twilio.ts`** — Same: delegate to `verifyHmac()`.

**`packages/gateway/src/sources/slack-slash.ts`** — Same: delegate to `verifyHmac()`.

**`packages/gateway/src/sources/xapi.ts:95-98`** — For basic auth, pad shorter
buffer to match longer before comparison:

```typescript
function constantTimeCompare(a: Buffer, b: Buffer): boolean {
  const maxLen = Math.max(a.length, b.length);
  const padA = Buffer.alloc(maxLen);
  const padB = Buffer.alloc(maxLen);
  a.copy(padA); b.copy(padB);
  return timingSafeEqual(padA, padB) && a.length === b.length;
}
```

### Tests

- Verify existing test suites still pass after refactoring to `verifyHmac()`.
- Add test: mismatched-length signatures are still rejected.

---

## Phase 4: Action Link Replay Protection ✅

### Problem

Action links sign `workflowId + event` with HMAC but include no timestamp or nonce.
A captured link can be replayed indefinitely — critical for email approval flows.

### Changes

**`packages/durable-machine/src/channels/email.ts:104-112`**

Include a creation timestamp in the signed payload and the query params:

```typescript
export function signActionLink(
  workflowId: string,
  event: string,
  secret: string,
  createdAt: number = Date.now(),
): string {
  return createHmac("sha256", secret)
    .update(`${workflowId}:${event}:${createdAt}`)
    .digest("hex");
}

function actionUrl(
  baseUrl: string,
  workflowId: string,
  event: string,
  secret: string,
): string {
  const createdAt = Date.now();
  const sig = signActionLink(workflowId, event, secret, createdAt);
  const params = new URLSearchParams({
    workflowId, event, sig, t: String(createdAt),
  });
  return `${baseUrl}?${params.toString()}`;
}
```

**`packages/gateway/src/sources/action-link.ts:27-38`**

Verify the timestamp is present and within a configurable window (default 24h):

```typescript
export function actionLinkSource(
  signingSecret: string,
  opts?: { maxAgeSec?: number },
): WebhookSource<ActionLinkPayload> {
  const maxAge = (opts?.maxAgeSec ?? 86400) * 1000; // 24h default
  return {
    async verify(req: RawRequest): Promise<void> {
      const params = parseQueryParams(req);
      const { workflowId, event, sig, t } = params;
      if (!workflowId || !event || !sig || !t) {
        throw new WebhookVerificationError("Missing required query parameters", "action-link");
      }
      const createdAt = parseInt(t, 10);
      if (Number.isNaN(createdAt) || Date.now() - createdAt > maxAge) {
        throw new WebhookVerificationError("Action link expired", "action-link");
      }
      // Verify signature covers timestamp
      verifyHmac("sha256", signingSecret, `${workflowId}:${event}:${createdAt}`, sig, "action-link");
    },
    // ...
  };
}
```

### Tests

- Test: link with valid timestamp and signature → accepted.
- Test: link with expired timestamp → 401.
- Test: link with tampered timestamp → 401 (signature mismatch).
- Test: link missing `t` parameter → 401.

---

## Phase 5: Email Header Injection Prevention ✅

### Problem

Email subject is built from `prompt.text()` output. If the text contains CRLF
sequences (`\r\n`), an attacker can inject arbitrary email headers (Bcc, Cc, etc.).

### Changes

**`packages/durable-machine/src/channels/email.ts:63`**

Sanitize the subject by stripping control characters:

```typescript
function sanitizeSubject(s: string): string {
  return s.replace(/[\r\n\t]/g, " ").trim();
}

// In sendPrompt:
const subject = sanitizeSubject(subjectPrefix ? `${subjectPrefix} ${text}` : text);
```

Also sanitize `resolvePrompt` subject at line 76:

```typescript
const subject = sanitizeSubject(
  subjectPrefix ? `${subjectPrefix} Resolved: ${params.event.type}` : `Resolved: ${params.event.type}`,
);
```

### Tests

- Test: text containing `\r\nBcc: attacker@evil.com` → stripped to single line.

---

## Phase 6: Authentication and Authorization

### Problem

REST API, dashboard, SSE endpoints, admin/metrics — all unauthenticated. Anyone
with network access can read/modify/cancel any workflow, stream live state updates,
and enumerate instances.

### Approach

Add a pluggable auth middleware system. Library consumers provide their own
authentication logic via a callback; the gateway applies it to all routes.

**`packages/gateway/src/types.ts`** — Add auth types:

```typescript
export interface AuthMiddleware {
  /** Verify the request and throw/return 401 on failure. */
  (c: HonoContext, next: () => Promise<void>): Promise<Response | void>;
}

export interface GatewaySecurityOptions {
  /** Auth middleware for REST API routes. */
  restAuth?: AuthMiddleware;
  /** Auth middleware for dashboard routes. Applied to all dashboard pages and SSE streams. */
  dashboardAuth?: AuthMiddleware;
  /** Auth middleware for admin endpoints (/healthz, /ready, /metrics). */
  adminAuth?: AuthMiddleware;
}
```

**`packages/gateway/src/lifecycle.ts`** — Accept `security` option and apply
middleware:

```typescript
export interface GatewayContextOptions {
  // ... existing
  security?: GatewaySecurityOptions;
}

// In createGatewayContext:
if (security?.restAuth) {
  restApp.use("*", security.restAuth);
}
if (security?.dashboardAuth) {
  dashboardApp.use("*", security.dashboardAuth);
}
```

**`packages/gateway/src/admin.ts`** — Accept optional auth middleware for the
metrics endpoint:

```typescript
if (options.metricsAuth) {
  app.use("/metrics", options.metricsAuth);
}
```

**Dashboard SSE connection limits** — Add a concurrent connection counter:

```typescript
// In createDashboardRoutes:
let sseConnections = 0;
const maxSseConnections = options.maxSseConnections ?? 100;

// Before each SSE stream:
if (sseConnections >= maxSseConnections) {
  return c.json({ error: "Too many concurrent connections" }, 429);
}
sseConnections++;
// ... in finally block:
sseConnections--;
```

### Generic source production guard

**`packages/gateway/src/sources/generic.ts`** — Log a warning at construction time:

```typescript
export function genericSource(): WebhookSource<unknown> {
  console.warn(
    "[durable-xstate] WARNING: genericSource() has no webhook verification. " +
    "Do NOT use in production.",
  );
  // ...
}
```

### xAPI source default-deny

**`packages/gateway/src/sources/xapi.ts:46-47`** — Replace silent pass-through
with explicit opt-in:

```typescript
} else if (!validateAuth && !credentials && !bearerToken) {
  throw new WebhookVerificationError(
    "No auth configured. Set credentials, bearerToken, or validateAuth. " +
    "For dev mode, pass validateAuth: async () => {}.",
    "xapi",
  );
}
```

### Tests

- Integration test: request without auth middleware → succeeds (backward compatible).
- Integration test: request with auth middleware that rejects → 401.
- Unit test: SSE connection over limit → 429.
- Unit test: `xapiSource({})` → throws.
- Unit test: `genericSource()` logs warning.

---

## Phase 7: Worker Resilience

### Problem

Multiple resource exhaustion and crash-recovery gaps in the worker:

1. `consumeAndProcessMessages` recurses unboundedly — a self-triggering workflow
   causes OOM.
2. Actor invocations have no timeout — a hanging HTTP call blocks the processing
   thread forever.
3. Semaphore wait queue is unbounded — NOTIFY flood grows memory without limit.
4. Effect outbox entries stuck in "executing" after crash are never retried.
5. LISTEN reconnect uses fixed 1s interval with no backoff.

### Changes

**`packages/durable-machine/src/pg/create-durable-machine.ts:90-93`** —
Add recursion depth limit:

```typescript
const MAX_DRAIN_ROUNDS = 20;

async function consumeAndProcessMessages(instanceId: string): Promise<void> {
  for (let i = 0; i < MAX_DRAIN_ROUNDS; i++) {
    const count = await processBatchFromLog(deps, instanceId, useBatch ? undefined : 1);
    if (count === 0) return;
  }
  // Remaining events will be picked up by next NOTIFY or poll cycle
}
```

**`packages/durable-machine/src/pg/event-processor.ts:108-114`** —
Add invocation timeout:

```typescript
const INVOKE_TIMEOUT_MS = 30_000;

// In executeInvocationsInline:
const result = await Promise.race([
  creator({ input: invocation.input }).then(
    (out) => ({ output: out, error: undefined }),
    (err) => ({ output: undefined, error: err }),
  ),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Invocation "${invocation.src}" timed out after ${INVOKE_TIMEOUT_MS}ms`)), INVOKE_TIMEOUT_MS),
  ),
]);
```

Make the timeout configurable via `DurableMachineOptions`:

```typescript
export interface DurableMachineOptions {
  // ... existing
  invokeTimeoutMs?: number;
}
```

**`packages/worker/src/pg/lifecycle.ts:78`** — Bound the semaphore wait queue:

```typescript
const MAX_QUEUE_SIZE = maxConcurrency * 10;

function acquirePermit(): Promise<void> {
  if (permits > 0) { permits--; return Promise.resolve(); }
  if (waitQueue.length >= MAX_QUEUE_SIZE) {
    return Promise.reject(new Error("Dispatch queue full"));
  }
  return new Promise<void>((resolve) => waitQueue.push(resolve));
}
```

Update `dispatch()` to handle the rejection:

```typescript
function dispatch(instanceId: string, dm: PgDurableMachine): void {
  void acquirePermit().then(async () => {
    // ... existing
  }).catch((err) => {
    logger.warn({ instanceId, err: String(err) }, "dispatch skipped — queue full");
  });
}
```

**Effect outbox crash recovery** — Add a reaper query that resets stale
"executing" effects back to "pending":

**`packages/durable-machine/src/pg/queries.ts`**:

```typescript
export const Q_RESET_STALE_EFFECTS = {
  name: "dm_reset_stale_effects",
  text: `UPDATE effect_outbox
         SET status = 'pending'
         WHERE status = 'executing'
         AND created_at < $1
         RETURNING id`,
} as const;
```

**`packages/durable-machine/src/pg/store.ts`** — Add `resetStaleEffects(olderThanMs)`.

**`packages/worker/src/pg/lifecycle.ts`** — Call on startup:

```typescript
// In backend.start():
const staleThreshold = Date.now() - 5 * 60 * 1000; // 5 min
await store.resetStaleEffects(staleThreshold);
```

**LISTEN reconnect backoff** — Replace fixed 1s delay with exponential backoff:

**`packages/durable-machine/src/pg/store.ts:524-534`**:

```typescript
let reconnectAttempt = 0;
const MAX_RECONNECT_MS = 30_000;

function reconnect(): void {
  if (stopped) return;
  if (listenClient) {
    (listenClient as any).end().catch(() => {});
    listenClient = null;
  }
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_MS);
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    void connectListener();
  }, delay);
}

// In connectListener success path:
reconnectAttempt = 0;
```

### Tests

- Unit test: `consumeAndProcessMessages` stops after MAX_DRAIN_ROUNDS.
- Unit test: invocation timeout fires and records error result.
- Unit test: `acquirePermit()` rejects when queue is full.
- Integration test: `resetStaleEffects()` recovers orphaned effects.

---

## Phase 8: Defense-in-Depth Hardening

### Input validation

**`packages/gateway/src/rest-api.ts`** — Validate IDs and query params:

```typescript
const ID_PATTERN = /^[\w.:-]{1,256}$/;

function validateId(id: string, label: string, c: HonoContext): Response | null {
  if (!ID_PATTERN.test(id)) {
    return c.json({ error: `Invalid ${label}` }, 400);
  }
  return null;
}

// In each route:
const err = validateId(instanceId, "instanceId", c);
if (err) return err;
```

Validate `limit` and `after` query params in event log endpoint (lines 171-175):

```typescript
if (limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) {
    return c.json({ error: "limit must be 1-1000" }, 400);
  }
  opts.limit = n;
}
if (after) {
  const n = Number(after);
  if (!Number.isFinite(n) || n < 0) {
    return c.json({ error: "after must be a non-negative number" }, 400);
  }
  opts.afterSeq = n;
}
```

**`packages/gateway/src/dashboard/routes.ts`** — Same ID validation for dashboard
routes.

### Prototype pollution guard

**`packages/durable-machine/src/pg/store.ts:35-50`** — Strip dangerous keys from
deserialized context:

```typescript
function sanitizeContext(obj: unknown): Record<string, unknown> {
  if (typeof obj !== "object" || obj === null) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    result[key] = value;
  }
  return result;
}

// In rowToMachine:
context: sanitizeContext(row.context),
```

### CORS configuration

**`packages/gateway/src/lifecycle.ts`** — Accept CORS options:

```typescript
import { cors } from "hono/cors";

// In createGatewayContext:
if (options.cors) {
  mainApp.use("*", cors(options.cors));
}
```

### Content Security Policy for dashboard

**`packages/gateway/src/dashboard/html.ts`** — Add CSP meta tag to the HTML
template head:

```typescript
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; connect-src 'self'">
```

Add SRI hash to the ELK CDN script load in `client.ts`.

### NOTIFY payload validation

**`packages/durable-machine/src/pg/store.ts:505-508`** — Validate the split
result:

```typescript
const parts = msg.payload.split("::");
if (parts.length < 2) return; // Malformed — ignore
const [machineName, instanceId, topic] = parts;
if (!machineName || !instanceId) return;
listenCallback(machineName, instanceId, topic ?? "event");
```

### Slack slash command argument injection

**`packages/gateway/src/sources/slack-slash.ts:133-141`** — Prevent `type`
override from user-supplied args:

```typescript
transform: {
  transform(payload: SlackSlashPayload): XStateEvent {
    const { type: _, ...safeArgs } = payload.args; // Strip 'type' key
    return { type: eventType, ...safeArgs };
  },
},
```

### Configuration upper bounds

**`packages/durable-machine/src/pg/config.ts`** — Add maximum value validation:

```typescript
const LIMITS = {
  WAKE_POLLING_INTERVAL_MS: { max: 300_000 },
  EFFECT_POLLING_INTERVAL_MS: { max: 60_000 },
  MAX_CONCURRENCY: { max: 500 },
  PG_POOL_SIZE: { max: 200 },
};

// In each config parser:
if (val > LIMITS.MAX_CONCURRENCY.max) {
  throw new Error(`MAX_CONCURRENCY must be <= ${LIMITS.MAX_CONCURRENCY.max}`);
}
```

### Silent poll error logging

**`packages/worker/src/pg/lifecycle.ts:124`** — Log instead of silently catching:

```typescript
} catch (err) {
  logger.error({ err: String(err) }, "adaptive poll tick failed");
}
```

### Hardcoded fallback secrets in examples

**`examples/webhook-approval/src/pg-gateway.ts:26`** — Remove fallback:

```typescript
slackSigningSecret: requireEnv("SLACK_SIGNING_SECRET"),
```

Add a `requireEnv` helper or use the existing config parser pattern that throws
on missing values.

---

## Summary

| Phase | Scope | Severity | Status | Files |
|-------|-------|----------|--------|-------|
| 1 | Request body limits | Critical (DoS) | **Done** | middleware.ts, gateway.ts, store.ts |
| 2 | Timestamp NaN bypass | High (Replay) | **Done** | stripe.ts, slack.ts, slack-slash.ts, linear.ts |
| 3 | Timing side-channels | High (Crypto) | **Done** | stripe.ts, slack.ts, slack-slash.ts, twilio.ts, xapi.ts |
| 4 | Action link replay | High (Replay) | **Done** | email.ts, action-link.ts |
| 5 | Email header injection | Critical (Injection) | **Done** | email.ts |
| 6 | Auth + SSE limits | Critical (AuthZ, DoS) | **Partial** | lifecycle.ts, types.ts, admin.ts, routes.ts, generic.ts, xapi.ts |
| 7 | Worker resilience | High (DoS, Data loss) | Open | create-durable-machine.ts, event-processor.ts, lifecycle.ts, store.ts, queries.ts |
| 8 | Defense-in-depth | Medium (Various) | **Partial** | rest-api.ts, routes.ts, store.ts, html.ts, client.ts, slack-slash.ts, config.ts |

### Verification

After each phase:

```bash
pnpm typecheck
pnpm test
pnpm lint:arch
```
