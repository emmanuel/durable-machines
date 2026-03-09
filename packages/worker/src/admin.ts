// NOTE: Parallel implementation in @durable-xstate/gateway/src/admin.ts.
// Keep both in sync if modifying.

import { createServer } from "node:http";
import type { Server } from "node:http";

export interface AdminServerOptions {
  metrics?: { registry: { metrics(): Promise<string>; contentType: string } };
  isReady?: () => boolean | Promise<boolean>;
}

export function createAdminServer(options?: AdminServerOptions): Server {
  const { metrics, isReady = () => true } = options ?? {};

  return createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.url === "/ready") {
      const ready = await isReady();
      res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: ready ? "ok" : "not ready" }));
      return;
    }

    if (req.url === "/metrics") {
      if (!metrics) {
        res.writeHead(404);
        res.end();
        return;
      }
      const text = await metrics.registry.metrics();
      res.writeHead(200, { "content-type": metrics.registry.contentType });
      res.end(text);
      return;
    }

    res.writeHead(404);
    res.end();
  });
}
