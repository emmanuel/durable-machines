# Patterns Reference

Covers validation, RPC type-safe client, testing, OpenAPI, JSX, streaming, and common pitfalls.

## Table of Contents
1. [Validation with Zod](#validation-with-zod)
2. [RPC Client (End-to-End Type Safety)](#rpc-client)
3. [OpenAPI with Zod](#openapi-with-zod)
4. [Testing](#testing)
5. [JSX Server-Side Rendering](#jsx)
6. [Streaming & SSE](#streaming)
7. [Common Pitfalls](#common-pitfalls)

---

## Validation with Zod

### Basic Setup

```bash
npm install zod @hono/zod-validator
```

### Validating Different Targets

The `zValidator` middleware validates `json`, `query`, `param`, `header`, `form`, and `cookie` targets:

```ts
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

const app = new Hono()

// Validate JSON body
app.post('/users',
  zValidator('json', z.object({
    name: z.string().min(1),
    email: z.string().email(),
  })),
  (c) => {
    const { name, email } = c.req.valid('json')  // fully typed
    return c.json({ name, email }, 201)
  }
)

// Validate query parameters
app.get('/search',
  zValidator('query', z.object({
    q: z.string(),
    page: z.string().optional(),
  })),
  (c) => {
    const { q, page } = c.req.valid('query')
    return c.json({ query: q, page })
  }
)

// Validate path parameters
app.get('/users/:id',
  zValidator('param', z.object({
    id: z.string().uuid(),
  })),
  (c) => {
    const { id } = c.req.valid('param')
    return c.json({ id })
  }
)

// Validate headers (use lowercase keys)
app.get('/protected',
  zValidator('header', z.object({
    authorization: z.string(),
  })),
  (c) => {
    const { authorization } = c.req.valid('header')
    return c.json({ authorized: true })
  }
)
```

### Custom Error Handling in Validators

The third argument to `zValidator` is an optional callback for custom error responses:

```ts
app.post('/users',
  zValidator('json',
    z.object({ name: z.string(), age: z.number() }),
    (result, c) => {
      if (!result.success) {
        return c.json({
          message: 'Validation failed',
          errors: result.error.issues,
        }, 422)
      }
    }
  ),
  (c) => {
    const user = c.req.valid('json')
    return c.json(user, 201)
  }
)
```

### Multiple Validators on One Route

You can stack validators for different targets:

```ts
app.put('/posts/:id',
  zValidator('param', z.object({ id: z.string() })),
  zValidator('json', z.object({ title: z.string(), body: z.string() })),
  (c) => {
    const { id } = c.req.valid('param')
    const { title, body } = c.req.valid('json')
    return c.json({ id, title, body })
  }
)
```

### Standard Schema Validator

For framework-agnostic validation (works with Zod, Valibot, ArkType):

```bash
npm install @hono/standard-validator
```

```ts
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'

app.post('/author', sValidator('json', z.object({
  name: z.string(),
  age: z.number(),
})), (c) => {
  const data = c.req.valid('json')
  return c.json({ success: true, message: `${data.name} is ${data.age}` })
})
```

---

## RPC Client

Hono's RPC feature gives you end-to-end type safety between server and client without code generation. The `hc` client infers types directly from the server route definitions.

### Server Side

Routes must be chained (not assigned separately) for type inference to work:

```ts
// server.ts
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

const app = new Hono()
  .get('/users',
    zValidator('query', z.object({ page: z.string().optional() })),
    (c) => {
      const { page } = c.req.valid('query')
      return c.json({ users: [], page })
    }
  )
  .post('/users',
    zValidator('json', z.object({
      name: z.string(),
      email: z.string().email(),
    })),
    (c) => {
      const data = c.req.valid('json')
      return c.json({ id: '123', ...data }, 201)
    }
  )
  .get('/users/:id', (c) => {
    return c.json({ id: c.req.param('id'), name: 'John' })
  })

export type AppType = typeof app
export default app
```

### Client Side

```ts
// client.ts
import { hc } from 'hono/client'
import type { AppType } from './server'

const client = hc<AppType>('http://localhost:3000')

// GET /users?page=1 — fully typed request and response
const res = await client.users.$get({ query: { page: '1' } })
const data = await res.json()  // typed as { users: any[]; page: string | undefined }

// POST /users — fully typed body
const createRes = await client.users.$post({
  json: { name: 'John', email: 'john@example.com' },
})
const created = await createRes.json()  // typed as { id: string; name: string; email: string }

// GET /users/:id — path parameters
const userRes = await client.users[':id'].$get({
  param: { id: '123' },
})
```

### Typed Error Responses by Status Code

Specify the status code in `c.json()` to enable per-status type inference on the client:

```ts
// server
const app = new Hono().get('/posts/:id', async (c) => {
  const post = await getPost(c.req.param('id'))
  if (!post) {
    return c.json({ error: 'not found' }, 404)
  }
  return c.json({ post }, 200)
})

export type AppType = typeof app
```

```ts
// client
const res = await client.posts[':id'].$get({ param: { id: '123' } })

if (res.status === 404) {
  const data = await res.json()  // typed as { error: string }
}
if (res.ok) {
  const data = await res.json()  // typed as { post: Post }
}
```

### Type Helpers

```ts
import type { InferRequestType, InferResponseType } from 'hono/client'

// Infer the request type for a route
type CreateUserInput = InferRequestType<typeof client.users.$post>['json']

// Infer response type (default: all statuses)
type UserResponse = InferResponseType<typeof client.users.$get>

// Infer response type for specific status
type UserResponse200 = InferResponseType<typeof client.users.$get, 200>
```

### With React Query

```ts
import { useQuery, useMutation } from '@tanstack/react-query'
import { hc, InferResponseType, InferRequestType } from 'hono/client'
import type { AppType } from '../server'

const client = hc<AppType>('/api')

function Users() {
  const query = useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await client.users.$get()
      return res.json()
    },
  })

  const mutation = useMutation({
    mutationFn: async (data: InferRequestType<typeof client.users.$post>['json']) => {
      const res = await client.users.$post({ json: data })
      return res.json()
    },
  })

  return /* ... */
}
```

### RPC Gotchas

- **Routes must be chained** — `const app = new Hono().get(...)` not `app.get(...)` separately
- **Don't annotate the `c` parameter** — writing `(c: Context) =>` breaks type inference; let it be inferred
- **Export the app type from a variable** — `const route = app.get(...); export type AppType = typeof route`
- **`tsconfig.json` must have `"strict": true`** for RPC types to work in monorepos

---

## OpenAPI with Zod

`@hono/zod-openapi` extends Hono to generate OpenAPI 3.0 specs from your Zod schemas.

```bash
npm install @hono/zod-openapi
```

```ts
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'

const ParamsSchema = z.object({
  id: z.string().min(3).openapi({
    param: { name: 'id', in: 'path' },
    example: '123',
  }),
})

const UserSchema = z.object({
  id: z.string().openapi({ example: '123' }),
  name: z.string().openapi({ example: 'John Doe' }),
  age: z.number().openapi({ example: 42 }),
}).openapi('User')

const route = createRoute({
  method: 'get',
  path: '/users/{id}',
  request: { params: ParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: UserSchema } },
      description: 'Returns the user',
    },
  },
})

const app = new OpenAPIHono()

app.openapi(route, (c) => {
  const { id } = c.req.valid('param')
  return c.json({ id, name: 'John Doe', age: 42 }, 200)
})

// Serve the OpenAPI spec at /doc
app.doc('/doc', {
  openapi: '3.0.0',
  info: { version: '1.0.0', title: 'My API' },
})

export default app
```

The OpenAPI route definitions also work with Hono's RPC client for end-to-end type safety.

---

## Testing

Hono apps are testable without starting a server. Use `app.request()` to send virtual requests.

### Basic Testing with `app.request()`

```ts
// Works with any test runner: vitest, jest, bun:test, Deno.test
import { describe, it, expect } from 'vitest'
import app from './app'

describe('API', () => {
  it('GET /posts returns 200', async () => {
    const res = await app.request('/posts')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Many posts')
  })

  it('POST /posts returns 201', async () => {
    const res = await app.request('/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'New Post' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ message: 'Created' })
  })

  it('POST /posts with form data', async () => {
    const formData = new FormData()
    formData.append('title', 'Hello')
    const res = await app.request('/posts', {
      method: 'POST',
      body: formData,
    })
    expect(res.status).toBe(201)
  })
})
```

Important: when testing JSON endpoints, you **must** include `'Content-Type': 'application/json'` in headers — otherwise the body won't parse.

### Mocking Environment Bindings

Pass the env object as the 3rd argument to `app.request()`:

```ts
const MOCK_ENV = {
  DATABASE_URL: 'postgres://test:test@localhost/test',
  MY_KV: { get: async () => 'mocked-value' },
}

it('accesses env', async () => {
  const res = await app.request('/data', {}, MOCK_ENV)
  expect(res.status).toBe(200)
})
```

### Typed Test Client (`testClient`)

For type-safe testing with autocompletion (requires chained route definitions):

```ts
import { testClient } from 'hono/testing'
import app from './app'

it('search works', async () => {
  const client = testClient(app)
  const res = await client.search.$get({ query: { q: 'hono' } })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ query: 'hono', results: ['result1'] })
})
```

To pass headers with `testClient`:

```ts
const res = await client.search.$get(
  { query: { q: 'hono' } },
  { headers: { Authorization: 'Bearer token123' } }
)
```

To mock env with `testClient`:

```ts
const client = testClient(app, MOCK_ENV)
```

### testClient Type Inference Gotcha

`testClient` only provides typed routes when the app uses chained definitions:

```ts
// This works — testClient gets types
const app = new Hono().get('/search', (c) => c.json({ hello: 'world' }))

// This does NOT work for testClient types (but works for app.request)
const app = new Hono()
app.get('/search', (c) => c.json({ hello: 'world' }))
```

---

## JSX

Hono has built-in JSX support for server-side rendering without React.

### Setup

Rename files to `.tsx` and configure `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx"
  }
}
```

### Basic Usage

```tsx
import { Hono } from 'hono'

const app = new Hono()

const Layout = ({ children }) => (
  <html>
    <body>{children}</body>
  </html>
)

const Home = () => (
  <Layout>
    <h1>Hello Hono JSX!</h1>
  </Layout>
)

app.get('/', (c) => c.html(<Home />))
```

### Streaming with Suspense

```tsx
import { renderToReadableStream, Suspense } from 'hono/jsx/streaming'

const AsyncData = async () => {
  const data = await fetchData()
  return <div>{data}</div>
}

app.get('/', (c) => {
  const stream = renderToReadableStream(
    <html>
      <body>
        <Suspense fallback={<div>Loading...</div>}>
          <AsyncData />
        </Suspense>
      </body>
    </html>
  )
  return c.body(stream, {
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Transfer-Encoding': 'chunked',
    },
  })
})
```

### ErrorBoundary

```tsx
import { ErrorBoundary } from 'hono/jsx'

app.get('/', (c) => c.html(
  <ErrorBoundary fallback={<div>Something went wrong</div>}>
    <RiskyComponent />
  </ErrorBoundary>
))
```

### JSX Renderer Middleware

For applying a common layout to all routes:

```ts
import { jsxRenderer } from 'hono/jsx-renderer'

app.use(jsxRenderer(({ children }) => (
  <html>
    <head><title>My App</title></head>
    <body>{children}</body>
  </html>
)))

app.get('/', (c) => c.render(<h1>Home</h1>))
app.get('/about', (c) => c.render(<h1>About</h1>))
```

---

## Streaming

### Basic Streaming

```ts
import { stream } from 'hono/streaming'

app.get('/stream', (c) => {
  return stream(c, async (stream) => {
    stream.onAbort(() => console.log('Client disconnected'))
    await stream.write(new Uint8Array([72, 101, 108, 108, 111]))
    await stream.pipe(someReadableStream)
  })
})
```

### Server-Sent Events (SSE)

```ts
import { streamSSE } from 'hono/streaming'

app.get('/sse', (c) => {
  return streamSSE(c, async (stream) => {
    let id = 0
    while (true) {
      await stream.writeSSE({ data: `event ${id}`, event: 'update', id: String(id++) })
      await stream.sleep(1000)
    }
  })
})
```

### Error Handling in Streams

The third argument is an optional error handler. `app.onError()` is NOT triggered for errors inside streams (because headers are already sent):

```ts
app.get('/stream', (c) => {
  return stream(c, async (stream) => {
    await stream.write('data...')
  }, (err, stream) => {
    stream.writeln('An error occurred!')
    console.error(err)
  })
})
```

---

## Common Pitfalls

### 1. Annotating the context parameter breaks type inference

```ts
// ❌ Breaks RPC and validator type inference
app.get('/users/:id', (c: Context) => { ... })

// ✅ Let TypeScript infer it
app.get('/users/:id', (c) => { ... })
```

### 2. Throwing plain Error instead of HTTPException

```ts
// ❌ No status code, poor error handling
throw new Error('Unauthorized')

// ✅ Proper HTTP error with status
throw new HTTPException(401, { message: 'Unauthorized' })
```

### 3. Missing Content-Type in tests

```ts
// ❌ Body won't be parsed — c.req.valid('json') returns {}
const res = await app.request('/api', {
  method: 'POST',
  body: JSON.stringify({ key: 'value' }),
})

// ✅ Include the Content-Type header
const res = await app.request('/api', {
  method: 'POST',
  body: JSON.stringify({ key: 'value' }),
  headers: { 'Content-Type': 'application/json' },
})
```

### 4. Header validation requires lowercase keys

```ts
// ❌ Won't match
zValidator('header', z.object({ 'X-Request-ID': z.string() }))

// ✅ Use lowercase
zValidator('header', z.object({ 'x-request-id': z.string() }))
```

### 5. Non-chained routes lose RPC types

```ts
// ❌ testClient and hc won't infer route types
const app = new Hono()
app.get('/users', handler)

// ✅ Chain for type inference
const app = new Hono().get('/users', handler)
```

### 6. Separate app definition from entry point

Keep the Hono app in `app.ts` and the runtime adapter in `index.ts`. This lets you import the app directly in tests without starting a server, and makes it trivial to switch runtimes.

### 7. createHandlers for controller-style code

If you prefer separating handlers into controller files, use `createFactory` to preserve type inference:

```ts
import { createFactory } from 'hono/factory'

const factory = createFactory()

const handlers = factory.createHandlers(
  logger(),
  authMiddleware,
  (c) => c.json(c.var.user)
)

app.get('/profile', ...handlers)
```
