# Application Lifecycle Patterns

Dense, transferable patterns for building production Node.js/Express APIs with structured startup, graceful shutdown, observability, and multi-tenant auth.

## Three-Phase Startup

Every entry point follows `parse → build → run`:

```
1. parseConfigFromEnv()     — synchronous, pure, throws on invalid config
2. createAppContext(config)  — async, builds all dependencies, may retry
3. startServer(ctx)          — async, binds ports, returns a shutdown handle
```

**Why three phases:** Config parsing is deterministic and fast — if it fails, the process exits immediately with a clear error. Context creation may involve network (DB connections, key fetches) — it retries with backoff. Server start depends on both being complete. Each phase's failure mode is distinct and handled differently.

### Phase 1: Configuration

Parse `process.env` through a **single Zod schema** — one pass, one source of truth. Every environment variable the app reads flows through this function. The result is a frozen, typed `AppConfig` object threaded everywhere by value.

**Key decisions:**
- **Coerce at the boundary.** Zod `.coerce.number()` and custom `z.stringbool()` transform strings to native types at parse time. Downstream code never touches `process.env` or calls `parseInt`.
- **Default aggressively.** Every field has a sensible default (ports, pool sizes, timeouts, feature flags). The minimum viable config is just `DATABASE_URL`.
- **Fail with all errors at once.** Use `safeParse()` and format all field errors into a single message. Don't make operators fix them one at a time.
- **Derive, don't duplicate.** `LOG_LEVEL` defaults to `'silent'` when `NODE_ENV=test`. Comma-separated env vars split into `string[]` in the transform.

```typescript
const envSchema = z.object({
  API_PORT: z.coerce.number().min(0).max(65535).default(8080),
  ADMIN_PORT: z.coerce.number().min(0).max(65535).default(8090),
  DATABASE_URL: z.string().url(),
  PG_POOL_SIZE: z.coerce.number().positive().default(20),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().positive().default(30_000),
  CORS_ALLOWED_ORIGINS: z.string().default('*').transform(s => s.split(',')),
  ENABLE_METRICS: z.stringbool().default('true'),
  RUN_MODE: z.enum(['combined', 'api', 'worker']).default('combined'),
  // ...every other env var
});
```

### Phase 2: Application Context

A plain object (not a class, not a DI container) that holds every shared dependency:

```typescript
interface AppContext {
  config: AppConfig;
  logger: Logger;
  pool: Pool;
  jwksCache: JwksCache;
  assetStore: AssetStore;
  metrics: AppMetrics;
  integrations: IntegrationRegistry;
  // Partially-applied DB helpers that close over pool + metrics:
  asUser<T>(auth: AuthPayload, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  withTenantClient<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
}
```

**Construction order matters.** Logger first (everything else logs). DB pool second (with retry). Then JWKS cache, asset store, metrics, integrations. Each step can depend on previous ones.

**DB connection retry:** Wrap `pool.query('SELECT 1')` in a loop with linear backoff (e.g., 5 retries, 2s delay). In Kubernetes, the DB pod may not be ready when the API pod starts. Log each retry attempt.

**Dynamic imports for optional features:** Use `await import('./s3-asset-store.ts')` vs `./local-asset-store.ts` based on config. This keeps optional dependencies out of the main bundle and makes the code self-documenting about what's required vs optional.

### Phase 3: Server Start

Create Express apps, start listening, start background workers, return a `ServerHandle` with a `shutdown()` method:

```typescript
interface ServerHandle {
  shutdown(): Promise<void>;
  apiServer: http.Server;
  adminServer: http.Server;
}
```

## Two-Port Architecture

Run **two separate Express apps on two separate ports**:

| Port | Purpose | Middleware |
|------|---------|-----------|
| API (8080) | All application traffic | Full stack: logging, auth, CORS, body parsing, metrics, routes |
| Admin (8090) | Operational endpoints | Minimal: health, readiness, metrics, internal auth subrequests |

**Why:** Kubernetes liveness/readiness probes need a port that's always responsive, even during shutdown drain. Prometheus scraping shouldn't compete with application traffic. Internal auth subrequests from the reverse proxy stay on a private network path.

**Shutdown ordering:** Stop the API server first (stop accepting new connections, drain existing ones). Keep the admin server alive during drain so readiness probes return 503 and the load balancer stops sending traffic. Close the admin server last.

## Graceful Shutdown

```
1. Set isShuttingDown = true (readiness probe starts returning 503)
2. Stop background worker (graphile-worker stop)
3. Run integration cleanup functions
4. Close API server:
   a. server.close()                    — stop accepting new connections
   b. server.closeIdleConnections()     — drop idle keep-alive immediately
   c. setTimeout(80% of timeout) →
      server.closeAllConnections()      — force-kill after grace period
5. Close admin server (immediate, should be idle by now)
6. Close DB connection pool
```

**The 80% rule:** Use 80% of the shutdown timeout for connection draining. The remaining 20% is buffer for pool teardown and logger flushing. With a 30s timeout: 24s drain, 6s cleanup.

**Hard deadline:** Start a `setTimeout(shutdownTimeoutMs)` that calls `process.exit(1)` as a backstop. If graceful shutdown hangs (stuck query, deadlocked connection), the process still terminates.

### Signal Handling

Catch four events, all routing to the same `shutdownWithTimeout()`:

```typescript
process.on('SIGTERM', () => shutdownWithTimeout('SIGTERM'));
process.on('SIGINT',  () => shutdownWithTimeout('SIGINT'));
process.on('uncaughtException',  (err) => { logger.fatal(err); shutdownWithTimeout('uncaughtException'); });
process.on('unhandledRejection', (err) => { logger.fatal(err); shutdownWithTimeout('unhandledRejection'); });
```

**Guard against double-shutdown.** The `isShuttingDown` flag prevents concurrent shutdown from two signals arriving simultaneously.

## Request Identification

Every request gets a UUID that flows through the entire system:

1. **Generate or propagate:** `req.headers['x-request-id'] ?? crypto.randomUUID()`
2. **Attach to request:** Available as `req.id`
3. **Bind to logger:** `req.log` is a pino child logger with `{ requestId }` bound — every log line from that request includes the ID without explicit threading
4. **Echo to client:** Set `X-Request-Id` response header so clients can correlate
5. **Include in metrics:** Available via `req.id` for error correlation

**Propagation across services:** If your architecture has downstream service calls, forward `X-Request-Id` in outgoing requests. This creates a distributed trace without a full tracing system.

## Structured Logging

Use **pino** (JSON structured logging) with **pino-http** middleware:

- **Automatic request/response logging.** pino-http logs request start and response finish with duration, status code, content length.
- **Child loggers per request.** `req.log.info('thing happened')` automatically includes `requestId` without the developer threading it.
- **Serializer customization.** Redact sensitive query parameters (tokens, keys) in the URL serializer. Only log the fields you need from request/response objects.
- **Level defaults by environment.** `NODE_ENV=test` → `silent`. Production → `info`. Developers can override with `LOG_LEVEL`.

## Metrics

### Setup

Use **prom-client** with a **custom Registry** (not the default global). This prevents metric collisions if your process loads libraries that also use prom-client.

```typescript
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
// Register custom metrics on this registry
```

### HTTP Metrics Middleware

Wrap every request with a metrics middleware that records:
- `http_request_duration_seconds` (histogram) — labels: method, route, status_code, tenant_id
- `http_requests_total` (counter) — same labels
- `http_active_connections` (gauge)

**Route normalization is critical.** Replace UUIDs and numeric path segments with `:id` to prevent label cardinality explosion. `/cmi5/courses/550e8400-e29b-41d4-a716-446655440000` becomes `/cmi5/courses/:id`.

```typescript
function normalizeRoute(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+/g, '/:id');
}
```

**Use `process.hrtime.bigint()`** for nanosecond-precision duration measurement. Don't use `Date.now()`.

**Tenant as a label.** If you're multi-tenant, include `tenant_id` in metric labels. This lets you alert on per-tenant SLOs and identify noisy neighbors. Read the tenant ID from the request after auth middleware has run (e.g., in the `res.on('finish')` callback).

### DB Pool Metrics

Listen on `pool.on('connect')` and `pool.on('release')` events to update a `db_pool_size` gauge with `total`, `idle`, `waiting` dimensions. This catches pool exhaustion before it becomes a timeout.

### Domain Metrics

Register counters and histograms for your domain events, not just HTTP. Examples:
- `statements_received_total` (counter, labels: tenant, verb)
- `machine_processing_seconds` (histogram, labels: tenant, event_type)
- `background_jobs_total` (counter, labels: task, status)

### Expose at Admin Port

Serve `GET /metrics` on the admin port only. The handler calls `registry.metrics()` and returns Prometheus text format.

## Express Middleware Chain

Order matters. This is a proven production ordering:

```
1.  disable x-powered-by, trust proxy
2.  Store AppContext in app.locals (for IoC and auth)
3.  pino-http logger (attaches req.log and req.id)
4.  X-Request-Id echo header
5.  Body parsers (JSON, text, raw, urlencoded — with appropriate limits)
6.  CORS middleware
7.  OPTIONS preflight handler (204)
8.  Protocol-specific response headers
9.  Static asset serving (if applicable)
10. API router with:
    a. Metrics middleware
    b. Route-generated handlers (TSOA RegisterRoutes, or manual)
11. Special-case routes that frameworks can't express (cookie + redirect, streaming)
12. GraphQL endpoint (if applicable — mounted after auth middleware)
13. Terminal 404 handler
14. Central error handler (ErrorRequestHandler)
```

**The `skipFinalize` pattern:** When mounting middleware after server start (e.g., PostGraphile needs the HTTP server for WebSocket upgrade), create the app without terminal handlers, mount the late middleware, then call `finalizeApp()` to add 404 + error handlers last.

## TSOA → Express Integration

TSOA generates Express route handlers from TypeScript controller decorators. The integration points:

### IoC Container

Keep it minimal. No DI framework. Read `AppContext` from `req.app.locals.ctx` and pass it to controller constructors:

```typescript
const iocContainer: IocContainerFactory<Request> = (request) => ({
  get: <T>(Controller: new (ctx: AppContext) => T): T =>
    new Controller(request.app.locals.ctx),
});
```

### Security Definitions

Define security schemes in `tsoa.json`. TSOA generates middleware that calls your `expressAuthentication(request, securityName, scopes)` function. Dispatch on `securityName` to handle different auth mechanisms:

```typescript
async function expressAuthentication(req, securityName, scopes) {
  switch (securityName) {
    case 'jwt':    return verifyJwtToken(req);
    case 'basic':  return verifyBasicAuth(req);
    case 'bearer': return verifyBearerToken(req);
    default: throw new Error(`Unknown security: ${securityName}`);
  }
}
```

### Route Regeneration

After changing controller decorators, security schemes, or adding new controllers, run `tsoa spec-and-routes` to regenerate `routes.ts` and `swagger.json`. Commit the generated files — they're part of the build artifact.

## Multi-Tenant JWT Authentication

### The Lookup Chain

For multi-tenant apps where each tenant brings their own IdP:

```
1. Decode JWT (unverified) → read iss + aud claims
2. DB lookup: (iss, aud) → tenant_id, jwks_uri, oidc_discovery_url
3. If no jwks_uri cached: fetch OIDC discovery → cache jwks_uri
4. Get/create JWKS key resolver for that jwks_uri
5. Verify JWT signature using the per-IdP key resolver
6. Extract roles from token (e.g., realm_access.roles for Keycloak)
7. Return { tenantId, sub, roles }
```

**Why lookup by (iss, aud):** A single IdP may issue tokens for multiple tenants (different audiences). The `(issuer, audience)` pair uniquely identifies the tenant relationship.

### JWKS Caching

Hold a `Map<jwksUri, KeyResolver>` where each resolver is `jose.createRemoteJWKSet()`. The resolver handles key rotation and HTTP caching internally. Create resolvers lazily on first use per IdP. The map lives in `AppContext` and is shared across all requests.

### IdP Resolution Must Bypass RLS

The lookup `(iss, aud) → tenant_id` runs before you know which tenant to scope to. Use a `SECURITY DEFINER` function (PostgreSQL) or equivalent privilege escalation to bypass row-level security for this specific query.

### Setting Tenant Context

After auth, set the tenant context at the database session level:

```sql
BEGIN;
SET LOCAL ROLE app_role;                    -- switch to RLS-subject role
SELECT internal.set_tenant_context($1);     -- set GUC for RLS policies
-- ... execute queries (all scoped by RLS) ...
COMMIT;
```

The `SET LOCAL` scoping ensures the tenant context is transaction-scoped and automatically cleaned up. Never rely on connection-level state in a pooled environment.

## Health Checks

### Liveness (`/healthz`)

Always returns 200. No dependency checks. Proves the process is running and the HTTP stack works. If this fails, the orchestrator should restart the process.

### Readiness (`/ready`)

Two checks:
1. **Shutdown state:** If shutting down, return 503 immediately. This removes the pod from the service endpoint before connections drain.
2. **Database connectivity:** Acquire a client, run `SELECT 1`, release. If the pool is exhausted or the DB is down, return 503.

**Serve on admin port.** Probes shouldn't compete with application traffic or require authentication.

## Integration Registry

For optional features (integrations, cron jobs, cleanup tasks), use a lightweight registry pattern:

```typescript
interface IntegrationRegistry {
  registerCronTask(name, crontab, fn);   // background scheduled work
  registerAdminRoute(path, handler);      // admin HTTP endpoints
  registerStartupTask(fn);                // one-time bootstrap
  registerCleanup(fn);                    // graceful shutdown hooks
}
```

**Why a registry:** Core code iterates the registry at startup without importing integration modules directly. Integrations are conditionally loaded based on config:

```typescript
if (config.mr2BaseUrl) {
  const mr2 = await import('./integrations/mr2.ts');
  mr2.register(registry, config);
}
```

This keeps the dependency graph clean and makes integrations genuinely optional.

## Run Modes

Support three deployment topologies with a single codebase:

| Mode | API Server | Background Worker | Admin Server |
|------|-----------|-------------------|-------------|
| `combined` | Yes | Yes | Yes |
| `api` | Yes | No | Yes |
| `worker` | No | Yes | Yes |

The `worker` mode uses a separate entry point that creates AppContext and starts only the worker + admin server. This lets you scale API and worker independently in production while running everything in one process during development.

## Error Handling

### REST API Errors

Define a minimal error class with `status`, `code`, and `message`:

```typescript
class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) { super(message); }
}
```

The central error handler reads these fields and returns a consistent JSON shape. For auth errors, TSOA's generated middleware sets `status = 401` automatically.

### GraphQL Error Masking

In production, mask unexpected errors with a random error ID. Log the real error server-side. Only pass through:
- Pure `GraphQLError` instances (client errors)
- Explicitly marked safe errors from resolvers
- Application-level DB exceptions (`RAISE EXCEPTION` with known SQLSTATE)

### Token/Secret Redaction

Custom log serializers should redact sensitive URL parameters (`?token=...`, `?key=...`) to prevent credentials from appearing in log aggregators.

---

## The Artifact Chain

Database schema changes drive a cascade of generated artifacts:

```
current.sql ──edit──► PostgreSQL ──introspect──► db/schema.graphql ──codegen──► generated.ts
                        │                           │                              │
                        ├──► db/schema.sql          ├──► routeTree.gen.ts          └──► frontend types
                        ├──► db/schema.er.md        │    (from route files)
                        └──► db/schema.dbml         │
                                                    └──► used by graphql-codegen
```

The chain has **two tiers with different infrastructure requirements**:

| Step | Requires DB? | Input | Output |
|------|:------------:|-------|--------|
| Schema exports | **Yes** | Live PostgreSQL introspection | `db/schema.graphql`, `.sql`, `.er.md`, `.dbml` |
| Codegen | **No** | `db/schema.graphql` (file on disk) | `packages/web/src/lib/graphql/generated.ts` |
| Route tree | **No** | Route files on disk | `routeTree.gen.ts` |

This split is critical: codegen reads the checked-in `schema.graphql` file, so pre-commit hooks, rebases, and CI can all regenerate `generated.ts` without a running database.

### Parallel Exports (`export-all.ts`)

The `afterCurrent` hook runs `export-all.ts`, which executes all four schema exports concurrently via `Promise.all()` on child processes, then runs codegen sequentially. This drops total time from ~4s (sequential) to ~2s (bounded by the slowest export, usually GraphQL introspection).

### When Artifacts Regenerate

| Trigger | Schema exports | Codegen | Route tree |
|---------|:--------------:|:-------:|:----------:|
| `pnpm dev:db` (file watch) | ✓ | ✓ | — |
| `pnpm db:setup` | ✓ | ✓ | — |
| `pnpm db:migrate:commit` | ✓ | ✓ | — |
| Pre-commit (if `.graphql` changed) | — | ✓ | ✓ |
| Merge train (after db:setup) | ✓ | ✓ | ✓ |

---

## Local Development

### Starting the Stack

The primary entry point is `pnpm up`, which runs `scripts/stack-up.sh`. It supports three infrastructure modes:

| Command | Mode | What it starts |
|---------|------|----------------|
| `pnpm up` | host | Postgres (Docker), API + worker on host |
| `pnpm up --compose` | compose | Postgres + Keycloak (Docker), API + worker on host, SCIM federation |
| `pnpm up --kind` | kind | Kind cluster + Tilt (everything in K8s) |

Additional flags:

| Flag | Effect |
|------|--------|
| `--seed=full\|demo\|none` | Reference data scope (default: `full` for host, `demo` otherwise) |
| `--seed-base` | Seed courses, alignments, frameworks after API starts |
| `--headless` | Skip Vite dev server and browser open (`--no-vite --no-browser`) |
| `--keep-db` | Don't tear down infrastructure on exit |

**What `pnpm up` does, step by step:**

1. **Port allocation.** Computes a deterministic offset from the directory name and derives `LMS_PG_PORT`, `LMS_KC_PORT`, and `VITE_PORT` (see [Deterministic Port Allocation](#deterministic-port-allocation)).
2. **Infrastructure.** Starts Postgres (all modes) and optionally Keycloak (compose/kind) via `docker-compose.test.yml`. Waits for health checks.
3. **Database setup.** `pnpm db:setup` drops + recreates the database, runs all committed migrations and `current.sql`, then fires afterCurrent hooks (parallel schema exports + codegen).
4. **Reference data.** Seeds global frameworks (full or demo subset) and optionally the base layer.
5. **API server.** `RUN_MODE=api API_PORT=0 pnpm dev` starts with tsx watch (hot-reload on TypeScript changes). Binds to deterministic `LMS_API_PORT` (18280 + worktree offset). `.env` is written upfront before infrastructure starts.
6. **SCIM federation** (compose only). Configures Keycloak to push users to the API's SCIM endpoint.
7. **Background worker.** `pnpm dev:worker` starts graphile-worker on a separate admin port.
8. **DB watcher.** `pnpm dev:db` starts graphile-migrate watch mode (see [DB Watcher](#db-watcher-graphile-migrate-watch)).
9. **Frontend.** `pnpm dev:ui` starts the Vite dev server, proxying API requests to the running backend.
10. **Ready sentinel.** Writes `.stack-ready` so other tools (`run-demos.sh`) know the stack is fully up.

**Shutting down:** Ctrl-C triggers the cleanup trap, which kills all tracked process trees (with a 5s grace period before SIGKILL), tears down Docker containers (unless `--keep-db`), and removes sentinel files. Or run `pnpm down` / `pnpm down:kind` from another terminal.

### Hot-Reload Chains

During development, four hot-reload chains run simultaneously:

| Change | Watcher | Effect |
|--------|---------|--------|
| TypeScript source (API) | tsx watch (`pnpm dev`) | API server restarts |
| TypeScript source (worker) | tsx watch (`pnpm dev:worker`) | Worker restarts |
| `current.sql` | graphile-migrate watch (`pnpm dev:db`) | DDL applied → schema exports → codegen |
| Frontend source | Vite HMR (`pnpm dev:ui`) | Browser hot-updates |

The net effect: **edit SQL → save → types update** in ~2 seconds.

### DB Watcher (graphile-migrate watch)

`pnpm dev:db` starts a continuous watcher that monitors `db/migrations/current.sql`:

1. Detect file change
2. Apply DDL to the local database
3. Run afterCurrent hooks (parallel exports + codegen via `export-all.ts`)

Use `pnpm dev:db --quick` to skip export hooks during rapid DDL iteration — it applies the DDL only, so you get sub-second feedback on syntax errors. Run the full exports via `pnpm db:setup` or `pnpm db:schema:all` when you're ready to regenerate artifacts.

### Deterministic Port Allocation

Each worktree gets a stable port offset so multiple worktrees can run simultaneously without collisions:

```bash
OFFSET=$(printf '%s' "$(basename "$ROOT_DIR")" | cksum | awk '{print $1 % 100}')
LMS_PG_PORT=$((15432 + OFFSET))    # Postgres: 15432–15531
LMS_KC_PORT=$((18080 + OFFSET))    # Keycloak: 18080–18179
VITE_PORT=$((5173 + OFFSET))       # Vite: 5173–5272
```

All ports are deterministic (computed from worktree directory name) and written to `.env` before infrastructure starts.

Kind mode computes its own offset via `deploy/scripts/lib.sh` (keyed on cluster name rather than directory name).

### Stack Observability (`pnpm status`)

`pnpm status` reports the current state of the development stack:

```
Git          branch, dirty state, commits ahead of main
Ports        deterministic offset, base port range
Services     Postgres (version), API port, Keycloak, Vite, stack PIDs
Database     migration count, current.sql pending lines
Artifacts    last-modified timestamps for schema files and codegen
```

---

## Pre-Commit Hooks

The pre-commit pipeline gates every `git commit`. Hooks run in this order:

| Stage | Hook | What it checks |
|-------|------|----------------|
| 1 | yaml-check, json-check | Syntax validation |
| 2 | trailing-whitespace, end-of-file-fixer | File hygiene |
| 3 | check-merge-conflict | Leftover conflict markers |
| 4 | gitleaks | Secret detection |
| 5 | squawk | PostgreSQL migration lint (config in `.squawk.toml`) |
| 6 | migration-naming | Migration files must have descriptive names (`000042-my-change.sql`) |
| 7 | migration-committed | `current.sql` must be empty (run `pnpm db:migrate:commit` first) |
| 8 | route-gen | Regenerate `routeTree.gen.ts` from route files |
| 9 | codegen | Regenerate `generated.ts` if `.graphql` files changed (no DB needed) |
| 10 | oxlint | Lint |
| 11 | oxfmt | Format (auto-stages reformatted files) |
| 12 | typecheck | `pnpm typecheck` (tsgo --noEmit) |
| 13 | test | `pnpm test` (unit tests) |
| 14 | conventional-commit | Commit message format |

**Key behaviors:**
- **codegen** only fires when `db/schema.graphql` or `packages/web/src/**/*.graphql` files are staged. It reads from the checked-in `schema.graphql` (no DB needed) and auto-stages the regenerated `generated.ts`.
- **migration-committed** blocks commits that include non-empty `current.sql`. Run `pnpm db:migrate:commit` first to move content into `db/migrations/committed/`.
- **oxfmt** may reformat files and re-stage them automatically.
- **squawk** enforces strict PostgreSQL migration conventions (e.g., `prefer-bigint-over-int`), failing on warnings not just errors.

---

## Validation and CI

### Local Validation (`pnpm validate`)

Runs the same checks as the merge train, against the current worktree:

```bash
pnpm validate                     # full: install → db:setup → typecheck → tests
pnpm validate -- --skip-db        # skip db:setup (schema already current)
pnpm validate -- --skip-tests     # typecheck only
pnpm validate -- --unit-only      # skip integration tests
```

Steps:
1. `pnpm install --frozen-lockfile` (falls back to `pnpm install` if lockfile needs updating)
2. `pnpm db:setup -- --skip-import` (migrations + schema exports + codegen, skip reference data)
3. `pnpm typecheck` (tsgo --noEmit across all packages)
4. `pnpm test:all` (unit + integration tests across all packages)

This is the recommended pre-flight check before requesting promotion.

### The Merge Train (`scripts/merge-train.sh`)

The merge train integrates branches into `main` with guaranteed linear history:

```bash
scripts/merge-train.sh integrations                  # validate only
scripts/merge-train.sh --promote integrations        # validate + fast-forward main
scripts/merge-train.sh --skip-validate integrations  # rebase only, skip validation
```

**Flow:**
1. Creates (or reuses) a dedicated `lms-engine-train` worktree
2. Detects baseline migration count from the base ref
3. Rebases each branch onto the train tip
4. Auto-resolves conflicts in generated files (`schema.graphql`, `schema.sql`, `schema.er.md`, `schema.dbml`, `generated.ts`) — these get regenerated during validation
5. Detects and renumbers colliding migration prefixes, rewriting the graphile-migrate hash chain (SHA-1 of previous hash + body)
6. **Validates:** `pnpm install` → `pnpm db:setup` (migrations + exports + codegen) → `pnpm typecheck` → `pnpm test:all`
7. If `--promote`: fast-forwards `main` to the validated train tip

**Fix-forward:** When validation fails due to a pre-existing issue (not caused by the promoted feature), the promote agent can make small surgical fixes on the branch and re-run — up to 3 attempts.

### CI Bring-Up Sequence

To run the full validation pipeline from a clean state (CI or fresh checkout):

```bash
# 1. Install dependencies
pnpm install

# 2. Start Postgres (deterministic port from env or auto-assign)
docker compose -f docker-compose.test.yml up -d --wait

# 3. Set DATABASE_URL
export DATABASE_URL="postgres://test:test@localhost:${LMS_PG_PORT}/lms_engine_test"

# 4. Run full validation (db:setup + typecheck + all tests)
pnpm validate

# 5. Tear down
docker compose -f docker-compose.test.yml down -v
```

Or for more granular control:

```bash
pnpm db:setup -- --skip-import    # migrate + schema exports + codegen
pnpm typecheck                    # tsgo --noEmit
pnpm test                         # unit tests (no DB needed after db:setup)
pnpm test:integration             # integration tests (needs Postgres)
```

**`docker-compose.test.yml` services:**

| Service | Image | Purpose |
|---------|-------|---------|
| postgres | `pgvector/pgvector:pg18` | Main DB + shadow DB (tmpfs — ephemeral) |
| fetch-scim-plugin | Alpine 3.21 | Downloads Keycloak SCIM plugin (compose mode) |
| keycloak | `quay.io/keycloak/keycloak:25.0.6` | OIDC provider (compose mode) |

### Database Lifecycle in CI

| Command | What it does |
|---------|-------------|
| `pnpm db:setup` | Drop → create → apply committed migrations → apply `current.sql` → afterCurrent hooks |
| `pnpm db:setup -- --skip-import` | Same, but skip reference data import (faster for validation) |
| `pnpm db:migrate:commit` | Move `current.sql` → `db/migrations/committed/NNNNN_*.sql` with hash chain |
| `pnpm db:migrate:uncommit` | Reverse the last commit (move back to `current.sql`) |

The afterCurrent hooks ensure `db/schema.graphql` and `generated.ts` are always in sync with the database after any migration operation.

### Test Infrastructure

| Command | Scope | DB required? |
|---------|-------|:------------:|
| `pnpm test` | Unit tests (vitest `--project unit`) | No |
| `pnpm test:integration` | Integration tests (vitest `--project integration`) | Yes |
| `pnpm test:all` | Both | Yes |
| `pnpm test:watch` | Unit tests in watch mode | No |
| `pnpm test:integration:watch` | Integration tests in watch mode | Yes |

Unit tests run in-process with mocks. Integration tests connect to the test database (port computed from worktree offset or `TEST_DB_PORT` env var) and exercise real SQL, migrations, and state machine transitions.

---

## Workflow Summary

### Daily Development Loop

```bash
pnpm up                           # start everything (Postgres, API, worker, DB watcher, Vite)
# edit TypeScript     → tsx watch restarts API/worker automatically
# edit current.sql    → graphile-migrate watch applies DDL + exports + codegen
# edit frontend       → Vite HMR updates browser
git add ... && git commit         # pre-commit: lint, format, typecheck, unit tests
pnpm down                         # tear down when done
```

### Migration Workflow

```bash
# 1. Edit current.sql (dev:db watcher applies it automatically)
# 2. Write code against the new schema (codegen ran automatically)
# 3. Run tests
pnpm test:all
# 4. Commit the migration
pnpm db:migration:commit            # moves current.sql → committed/NNNNN_*.sql
# 5. Git commit (pre-commit hook verifies current.sql is empty)
git add . && git commit -m "feat: add new table"
```

### Before Promotion

```bash
pnpm validate                     # full: install, db:setup, typecheck, all tests
# or for faster feedback:
pnpm validate -- --unit-only      # skip integration tests
```
