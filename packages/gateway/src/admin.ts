// NOTE: Parallel implementation in @durable-xstate/worker/src/admin.ts.
// Keep both in sync if modifying.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";

export interface AdminServerOptions {
  metricsHandler?: (req: IncomingMessage, res: ServerResponse) => void;
  isReady?: () => boolean | Promise<boolean>;
}

export function createAdminServer(options?: AdminServerOptions): Server {
  const { metricsHandler, isReady = () => true } = options ?? {};

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
      if (!metricsHandler) {
        res.writeHead(404);
        res.end();
        return;
      }
      metricsHandler(req, res);
      return;
    }

    res.writeHead(404);
    res.end();
  });
}
