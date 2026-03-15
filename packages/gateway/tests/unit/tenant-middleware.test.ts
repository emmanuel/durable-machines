import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createTenantMiddleware } from "../../src/tenant-middleware.js";
import type { TenantMiddlewareOptions } from "../../src/tenant-middleware.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Encode a JWT payload without signing (for decode-only tests). */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createTenantMiddleware", () => {
  let lookupTenant: TenantMiddlewareOptions["lookupTenant"];
  let app: Hono;

  beforeEach(() => {
    lookupTenant = vi.fn();
    // We mock at the middleware level — jwtVerify will be bypassed via the
    // test structure (the middleware rejects before reaching verify for most
    // error-path tests, and for the happy path we test the REST-API
    // integration instead).
    const mw = createTenantMiddleware({ lookupTenant });
    app = new Hono();
    app.use("/*", mw);
    app.get("/test", (c) => c.json({ tenantId: (c as any).get("tenantId") }));
  });

  it("rejects requests without Authorization header", async () => {
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toMatch(/Authorization/i);
  });

  it("rejects requests with non-Bearer token", async () => {
    const res = await app.request("/test", {
      headers: { authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid JWT (not decodable)", async () => {
    const res = await app.request("/test", {
      headers: { authorization: "Bearer not-a-jwt" },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toMatch(/Invalid JWT/i);
  });

  it("rejects JWT missing iss claim", async () => {
    const token = fakeJwt({ aud: "my-api" });
    const res = await app.request("/test", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toMatch(/iss/i);
  });

  it("rejects JWT missing aud claim", async () => {
    const token = fakeJwt({ iss: "https://auth.example.com" });
    const res = await app.request("/test", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toMatch(/aud/i);
  });

  it("rejects unknown tenant (lookupTenant returns null)", async () => {
    (lookupTenant as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const token = fakeJwt({ iss: "https://unknown.example.com", aud: "my-api" });
    const res = await app.request("/test", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toMatch(/Unknown tenant/i);
    expect(lookupTenant).toHaveBeenCalledWith("https://unknown.example.com", "my-api");
  });

  it("calls lookupTenant with first aud when aud is an array", async () => {
    (lookupTenant as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const token = fakeJwt({ iss: "https://auth.example.com", aud: ["api-1", "api-2"] });
    const res = await app.request("/test", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    expect(lookupTenant).toHaveBeenCalledWith("https://auth.example.com", "api-1");
  });
});

describe("REST API tenant integration", () => {
  it("uses getMachineForTenant when tenantMiddleware sets tenantId", async () => {
    // Simulates a simplified tenant middleware that just sets tenantId
    const { createRestApi } = await import("../../src/rest-api.js");
    const mockHandle = {
      workflowId: "inst-1",
      send: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockResolvedValue({
        value: "idle",
        context: {},
        status: "running" as const,
      }),
      getResult: vi.fn(),
      getSteps: vi.fn(),
      cancel: vi.fn(),
      getTransitions: vi.fn(),
      listEffects: vi.fn(),
      getEventLog: vi.fn(),
    };

    const mockDurable = {
      start: vi.fn().mockResolvedValue(mockHandle),
      get: vi.fn().mockReturnValue(mockHandle),
      list: vi.fn().mockResolvedValue([]),
      machine: {
        resolveState: () => ({ _nodes: [{ on: { SUBMIT: {} } }] }),
      },
    };

    const getMachineForTenant = vi.fn().mockReturnValue(mockDurable);

    // Simple middleware that sets tenantId without real JWT verification
    const fakeTenantMiddleware = async (c: any, next: any) => {
      c.set("tenantId", "tenant-abc");
      await next();
    };

    const app = createRestApi({
      machines: new Map(),
      tenantMiddleware: fakeTenantMiddleware,
      getMachineForTenant,
    });

    const res = await app.request(
      "/machines/order/instances/inst-1",
    );

    expect(res.status).toBe(200);
    expect(getMachineForTenant).toHaveBeenCalledWith("tenant-abc", "order");
  });

  it("falls back to machines map when no tenant context", async () => {
    const { createRestApi } = await import("../../src/rest-api.js");

    const mockHandle = {
      workflowId: "inst-1",
      send: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockResolvedValue({
        value: "idle",
        context: {},
        status: "running" as const,
      }),
      getResult: vi.fn(),
      getSteps: vi.fn(),
      cancel: vi.fn(),
      getTransitions: vi.fn(),
      listEffects: vi.fn(),
      getEventLog: vi.fn(),
    };

    const mockDurable = {
      start: vi.fn().mockResolvedValue(mockHandle),
      get: vi.fn().mockReturnValue(mockHandle),
      list: vi.fn().mockResolvedValue([]),
      machine: {
        resolveState: () => ({ _nodes: [{ on: { SUBMIT: {} } }] }),
      },
    };

    const app = createRestApi({
      machines: new Map([["order", mockDurable as any]]),
    });

    const res = await app.request(
      "/machines/order/instances/inst-1",
    );

    expect(res.status).toBe(200);
  });
});
