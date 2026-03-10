import { describe, it, expect, afterEach } from "vitest";
import { createAdminServer } from "../../src/admin.js";
import type { Server } from "node:http";

function request(
  server: Server,
  path: string,
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") return reject(new Error("no address"));
    const port = addr.port;
    import("node:http").then(({ get }) => {
      get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      }).on("error", reject);
    });
  });
}

describe("createAdminServer", () => {
  let server: Server;

  afterEach(() => {
    server?.close();
  });

  it("GET /healthz returns 200", async () => {
    server = createAdminServer();
    await new Promise<void>((r) => server.listen(0, r));

    const res = await request(server, "/healthz");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("GET /ready returns 200 when isReady returns true", async () => {
    server = createAdminServer({ isReady: () => true });
    await new Promise<void>((r) => server.listen(0, r));

    const res = await request(server, "/ready");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("GET /ready returns 503 when isReady returns false", async () => {
    server = createAdminServer({ isReady: () => false });
    await new Promise<void>((r) => server.listen(0, r));

    const res = await request(server, "/ready");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ status: "not ready" });
  });

  it("GET /ready supports async isReady", async () => {
    server = createAdminServer({ isReady: async () => false });
    await new Promise<void>((r) => server.listen(0, r));

    const res = await request(server, "/ready");
    expect(res.status).toBe(503);
  });

  it("GET /metrics returns content when metricsHandler provided", async () => {
    const metricsText = "# HELP test A test metric\ntest_total 42\n";
    server = createAdminServer({
      metricsHandler: (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(metricsText);
      },
    });
    await new Promise<void>((r) => server.listen(0, r));

    const res = await request(server, "/metrics");
    expect(res.status).toBe(200);
    expect(res.body).toBe(metricsText);
    expect(res.headers["content-type"]).toBe("text/plain; version=0.0.4");
  });

  it("GET /metrics returns 404 when no metricsHandler configured", async () => {
    server = createAdminServer();
    await new Promise<void>((r) => server.listen(0, r));

    const res = await request(server, "/metrics");
    expect(res.status).toBe(404);
  });

  it("unknown path returns 404", async () => {
    server = createAdminServer();
    await new Promise<void>((r) => server.listen(0, r));

    const res = await request(server, "/unknown");
    expect(res.status).toBe(404);
  });
});
