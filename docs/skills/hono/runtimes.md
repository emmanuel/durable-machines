# Runtime-Specific Setup

Covers scaffolding, entry points, static files, deployment, and runtime-specific APIs for each supported platform.

## Table of Contents
1. [Scaffolding (all runtimes)](#scaffolding)
2. [Cloudflare Workers](#cloudflare-workers)
3. [Node.js](#nodejs)
4. [AWS Lambda](#aws-lambda)
5. [Lambda@Edge](#lambdaedge)

---

## Scaffolding

All runtimes can be scaffolded with `create-hono`:

```bash
npm create hono@latest my-app
# or: pnpm create hono my-app
```

You'll be prompted to select a template: `cloudflare-workers`, `nodejs`, `aws-lambda`, etc. Then:

```bash
cd my-app
npm install
npm run dev
```

---

## Cloudflare Workers

Cloudflare Workers natively implement Web Standard Request/Response — no adapter needed.

### Entry Point

```ts
// src/index.ts
import { Hono } from 'hono'

const app = new Hono()
app.get('/', (c) => c.text('Hello Cloudflare Workers!'))

export default app
```

### Bindings (KV, D1, R2, Secrets)

Cloudflare environment bindings are accessed via `c.env`. Type them with generics:

```ts
type Bindings = {
  MY_KV: KVNamespace
  MY_BUCKET: R2Bucket
  MY_DB: D1Database
  SECRET_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/data', async (c) => {
  const value = await c.env.MY_KV.get('key')
  return c.json({ value })
})
```

Define bindings in `wrangler.toml`:

```toml
[vars]
SECRET_KEY = "my-secret"

[[kv_namespaces]]
binding = "MY_KV"
id = "abc123"

[[d1_databases]]
binding = "MY_DB"
database_name = "my-database"
database_id = "def456"
```

### Static Files

Use Cloudflare's Static Assets. In `wrangler.toml`:

```toml
assets = { directory = "./public" }
```

Files in `./public/` are served automatically (e.g., `./public/favicon.ico` → `/favicon.ico`).

### Combining with Other Event Handlers

```ts
export default {
  fetch: app.fetch,
  scheduled: async (event, env, ctx) => {
    // cron trigger handler
  },
}
```

### Dev & Deploy

```bash
npm run dev          # wrangler dev (local, default port 8787)
npx wrangler deploy  # deploy to Cloudflare
```

To change the dev port, update `wrangler.toml` or `wrangler.jsonc`.

### Types

Install `@cloudflare/workers-types` for full type definitions of KV, D1, R2, Durable Objects, etc.

### Testing

Use `@cloudflare/vitest-pool-workers` for Cloudflare-specific testing with bindings, or `app.request()` for portable tests (see patterns.md).

---

## Node.js

Node.js requires the `@hono/node-server` adapter since it doesn't natively implement Web Standard Request/Response.

### Requirements

Node.js 18.14.1+ (18.x), 19.7.0+ (19.x), or 20.0.0+. Use the latest version of each major release.

### Install

```bash
npm install hono @hono/node-server
```

### Entry Point

```ts
// src/index.ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()
app.get('/', (c) => c.text('Hello Node.js!'))

serve(app)  // default port 3000
```

### Custom Port and Graceful Shutdown

```ts
const server = serve({ fetch: app.fetch, port: 8080 })

process.on('SIGINT', () => {
  server.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  server.close((err) => {
    if (err) { console.error(err); process.exit(1) }
    process.exit(0)
  })
})
```

### HTTPS / HTTP2

```ts
import { createSecureServer } from 'node:http2'
import { readFileSync } from 'node:fs'

serve({
  fetch: app.fetch,
  createServer: createSecureServer,
  serverOptions: {
    key: readFileSync('key.pem'),
    cert: readFileSync('cert.pem'),
  },
})
```

### Accessing Node.js APIs

The Node.js adapter exposes the raw `http.IncomingMessage` and `http.ServerResponse` through `c.env`:

```ts
import { Hono } from 'hono'
import { serve, type HttpBindings } from '@hono/node-server'

const app = new Hono<{ Bindings: HttpBindings }>()

app.get('/', (c) => {
  return c.json({
    remoteAddress: c.env.incoming.socket.remoteAddress,
  })
})

serve(app)
```

### Static Files

```ts
import { serveStatic } from '@hono/node-server/serve-static'

app.use('/static/*', serveStatic({ root: './' }))
```

Important: `root` is relative to the current working directory (where you run `node`), not relative to the source file. With this structure:

```
my-app/
├── src/index.ts
└── static/hello.txt
```

Run from `my-app/` and use `serveStatic({ root: './' })` so `/static/hello.txt` resolves to `./static/hello.txt`.

You can also rewrite paths:

```ts
app.use('/assets/*', serveStatic({
  root: './',
  rewriteRequestPath: (path) => path.replace(/^\/assets/, '/static'),
}))
```

### Building for Production

1. Set `"outDir": "./dist"` in `tsconfig.json` `compilerOptions`
2. Add `"type": "module"` to `package.json`
3. Add build script: `"build": "tsc"`
4. Install TypeScript: `npm install typescript --save-dev`
5. Run `npm run build`, then `node dist/index.js`

### Dockerfile

```dockerfile
FROM node:20-alpine AS base

FROM base AS builder
RUN apk add --no-cache gcompat
WORKDIR /app
COPY package*json tsconfig.json src ./
RUN npm ci && npm run build && npm prune --production

FROM base AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 hono
COPY --from=builder --chown=hono:nodejs /app/node_modules /app/node_modules
COPY --from=builder --chown=hono:nodejs /app/dist /app/dist
COPY --from=builder --chown=hono:nodejs /app/package.json /app/package.json
USER hono
EXPOSE 3000
CMD ["node", "/app/dist/index.js"]
```

---

## AWS Lambda

Hono provides `hono/aws-lambda` which wraps the app in a Lambda-compatible handler.

### Install

```bash
npm install hono
npm install -D esbuild   # for bundling
```

### Entry Point

```ts
// lambda/index.ts
import { Hono } from 'hono'
import { handle } from 'hono/aws-lambda'

const app = new Hono()

app.get('/', (c) => c.text('Hello Lambda!'))

export const handler = handle(app)
```

The key difference from other runtimes: you export `handle(app)` as `handler` instead of exporting `app` directly.

### Accessing Lambda Event and Context

```ts
import { Hono } from 'hono'
import type { LambdaEvent, LambdaContext } from 'hono/aws-lambda'
import { handle } from 'hono/aws-lambda'

type Bindings = {
  event: LambdaEvent
  lambdaContext: LambdaContext
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/info', (c) => {
  return c.json({
    isBase64Encoded: c.env.event.isBase64Encoded,
    awsRequestId: c.env.lambdaContext.awsRequestId,
  })
})

export const handler = handle(app)
```

### API Gateway Request Context

```ts
app.get('/request-context', (c) => {
  const requestContext = c.env.event.requestContext
  return c.json({
    accountId: requestContext.accountId,
    stage: requestContext.stage,
    sourceIp: requestContext.identity?.sourceIp,
  })
})
```

### Binary Responses

Lambda requires base64 encoding for binary data. Hono handles this automatically when you set a binary Content-Type:

```ts
app.get('/image', async (c) => {
  const buffer = await generateImage()
  c.header('Content-Type', 'image/png')  // signals binary
  return c.body(buffer)                   // auto base64-encoded
})
```

### CDK Deployment

```ts
// lib/my-app-stack.ts
import * as cdk from 'aws-cdk-lib'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2'

export class MyAppStack extends cdk.Stack {
  constructor(scope, id, props?) {
    super(scope, id, props)

    const fn = new NodejsFunction(this, 'ApiFunction', {
      entry: 'lambda/index.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
    })

    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      defaultIntegration: new apigw.HttpLambdaIntegration(
        'LambdaIntegration', fn
      ),
    })
  }
}
```

### SST / Serverless Framework

Works the same way — point the function handler at the file exporting `handle(app)`.

---

## Lambda@Edge

For CloudFront Lambda@Edge, use `hono/lambda-edge` instead:

```ts
import { Hono } from 'hono'
import type { Callback, CloudFrontRequest } from 'hono/lambda-edge'
import { handle } from 'hono/lambda-edge'

type Bindings = {
  callback: Callback
  request: CloudFrontRequest
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', async (c, next) => {
  await next()
  c.env.callback(null, c.env.request)
})

export const handler = handle(app)
```

Note: Lambda@Edge does not support environment variables via the Lambda console. Use the CloudFront event object as an alternative.
