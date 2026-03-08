---
name: hono
description: Build web APIs and applications using the Hono HTTP framework. Use this skill whenever the user wants to create, scaffold, or work with a Hono project, build REST or RPC APIs with Hono, deploy to Cloudflare Workers, AWS Lambda, or Node.js using Hono, add middleware or validation to a Hono app, use Hono's RPC client for end-to-end type safety, or test a Hono application. Also trigger when the user mentions "hono", "edge framework", "multi-runtime API", or wants a lightweight Express alternative with TypeScript-first support. Even if they just say "create an API" or "build a server" and Hono is a reasonable choice, consider using this skill.
---

# Hono Web Framework

Hono (flame 🔥 in Japanese) is an ultrafast, lightweight web framework built on Web Standards. It runs on Cloudflare Workers, AWS Lambda, and Node.js with the same application code — only the entry point changes per runtime. Zero dependencies, under 14kB minified (`hono/tiny` preset), and 3.5x faster than Express on Node.js.

## When to read reference files

- **Setting up a new project or deploying to a specific runtime** → read `references/runtimes.md`
- **Validation, RPC, middleware patterns, testing, error handling, JSX** → read `references/patterns.md`

## Core Concepts

### Minimal Hello World

```ts
import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => c.text('Hello Hono!'))

export default app
```

On Cloudflare Workers, `export default app` is all you need. Node.js and Lambda need a thin adapter wrapper (see `references/runtimes.md`).

### The Context Object (`c`)

Every handler receives a Context object `c`:

```ts
// Response helpers
c.text('plain text')
c.json({ data: 'value' })
c.json({ message: 'Created' }, 201)       // with status
c.html('<h1>Hello</h1>')
c.redirect('/other')
c.notFound()
c.body(arrayBuffer)

// Request access
c.req.param('id')          // path parameters
c.req.query('page')        // query string
c.req.header('X-Custom')   // request headers
c.req.json()               // parse JSON body
c.req.formData()           // parse form data
c.req.valid('json')        // validated data (with validator middleware)

// Response mutation
c.status(201)
c.header('X-Custom', 'value')

// Environment bindings (Cloudflare KV, D1, Lambda context, etc.)
c.env.MY_BINDING

// Middleware variable passing
c.set('user', userObj)
c.get('user')              // also available as c.var.user
```

### Routing

```ts
// HTTP methods
app.get('/posts', handler)
app.post('/posts', handler)
app.put('/posts/:id', handler)
app.delete('/posts/:id', handler)
app.all('/any-method/*', handler)

// Path parameters — typed as literals when inline
app.get('/users/:id', (c) => {
  const id = c.req.param('id')
  return c.json({ id })
})

// Wildcards and regex
app.get('/files/*', handler)
app.get('/posts/:id{[0-9]+}', handler)

// Route grouping with app.route()
const api = new Hono()
api.get('/users', handler)
api.get('/posts', handler)

const app = new Hono()
app.route('/api', api)  // all routes prefixed with /api
```

**Best practice for type inference** — chain route definitions so types flow through for RPC:

```ts
// Types flow through the chain
const app = new Hono()
  .get('/users', (c) => c.json({ users: [] }))
  .post('/users', (c) => c.json({ created: true }, 201))

export type AppType = typeof app
```

```ts
// Separate sub-apps composed with route()
// routes/authors.ts
const app = new Hono()
  .get('/', (c) => c.json('list authors'))
  .post('/', (c) => c.json('create an author', 201))
  .get('/:id', (c) => c.json(`get ${c.req.param('id')}`))

export default app
export type AppType = typeof app
```

### Middleware

Middleware uses an onion model — code before `await next()` runs on the way in, code after runs on the way out:

```ts
app.use(async (c, next) => {
  const start = Date.now()
  await next()
  console.log(`${c.req.method} ${c.req.url} - ${Date.now() - start}ms`)
})
```

Register middleware for specific paths or methods:

```ts
app.use(logger())                          // all routes
app.use('/api/*', cors())                  // path prefix
app.post('/api/*', basicAuth({ ... }))     // method + path
```

Execution order follows registration order. The first registered middleware's pre-`next()` code runs first; its post-`next()` code runs last.

Note: if a handler or middleware throws, Hono catches it and routes it to `app.onError()`. `next()` itself never throws, so you don't need try/catch around it.

**Built-in middleware** (import from `hono/<name>`):
`logger`, `cors`, `basicAuth`, `bearerAuth`, `jwt`, `jwk`, `etag`, `compress`, `secureHeaders`, `cache`, `csrf`, `bodyLimit`, `timeout`, `prettyJSON`, `requestId`, `ipRestriction`, `contextStorage`, `combine`, `language`, `methodOverride`, `trailingSlash`

### Custom Middleware with Type Safety

```ts
import { createMiddleware } from 'hono/factory'

const authMiddleware = createMiddleware<{
  Variables: { user: { id: string; role: string } }
}>(async (c, next) => {
  const token = c.req.header('Authorization')
  if (!token) throw new HTTPException(401, { message: 'Unauthorized' })
  const user = await verifyToken(token)
  c.set('user', user)
  await next()
})

app.use('/admin/*', authMiddleware)
app.get('/admin/dashboard', (c) => {
  const user = c.get('user')  // typed as { id: string; role: string }
  return c.json({ user })
})
```

### Typed Bindings (Environment)

Pass generics to `new Hono()` for type-safe environment access:

```ts
type Bindings = {
  DATABASE_URL: string
  MY_KV: KVNamespace     // Cloudflare KV
}
type Variables = {
  user: { id: string }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
```

### Error Handling

Always use `HTTPException` for expected errors — not plain `Error`:

```ts
import { HTTPException } from 'hono/http-exception'

// Throw in handlers or middleware
app.get('/protected', (c) => {
  if (!authorized) {
    throw new HTTPException(401, { message: 'Unauthorized' })
  }
  return c.json({ data: 'secret' })
})

// Global error handler
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  console.error(err)
  return c.json({ error: 'Internal Server Error' }, 500)
})

// Custom 404
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404)
})
```

### Project Structure (Recommended)

```
my-api/
├── src/
│   ├── index.ts          # entry point (runtime-specific adapter)
│   ├── app.ts            # Hono app definition (portable)
│   ├── routes/
│   │   ├── users.ts      # sub-app for /users
│   │   └── posts.ts      # sub-app for /posts
│   ├── middleware/
│   │   └── auth.ts
│   └── lib/
│       └── db.ts
├── test/
│   └── routes.test.ts
├── package.json
└── tsconfig.json
```

Separate the app definition (`app.ts`) from the entry point (`index.ts`) so the same app can be imported for testing and reused across runtimes.

### Key Dependencies

| Package | Purpose |
|---|---|
| `hono` | Core framework |
| `@hono/node-server` | Node.js adapter (only needed on Node.js) |
| `@hono/zod-validator` | Zod validation middleware |
| `@hono/zod-openapi` | OpenAPI spec generation with Zod |
| `@hono/standard-validator` | Standard Schema validator (Zod, Valibot, ArkType) |

### Quick Reference: Common Patterns

**Streaming response**:
```ts
import { stream, streamSSE } from 'hono/streaming'

app.get('/stream', (c) => {
  return stream(c, async (stream) => {
    await stream.write('Hello ')
    await stream.write('World')
  })
})
```

**WebSocket** (Cloudflare Workers):
```ts
import { upgradeWebSocket } from 'hono/cloudflare-workers'

app.get('/ws', upgradeWebSocket((c) => ({
  onMessage(event, ws) { ws.send('echo: ' + event.data) },
  onClose() { console.log('closed') },
})))
```

**Cross-runtime env access**:
```ts
import { env } from 'hono/adapter'

app.get('/config', (c) => {
  const { API_KEY } = env<{ API_KEY: string }>(c)
  return c.json({ configured: !!API_KEY })
})
```
