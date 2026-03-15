import type { MiddlewareHandler } from "hono";
import { decodeJwt, createRemoteJWKSet, jwtVerify } from "jose";

export interface TenantLookupResult {
  id: string;
  jwksUrl: string;
}

export interface TenantMiddlewareOptions {
  lookupTenant: (iss: string, aud: string) => Promise<TenantLookupResult | null>;
}

export function createTenantMiddleware(
  options: TenantMiddlewareOptions,
): MiddlewareHandler {
  const { lookupTenant } = options;
  const jwksFunctions = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  function getJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
    let jwks = jwksFunctions.get(jwksUrl);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(jwksUrl));
      jwksFunctions.set(jwksUrl, jwks);
    }
    return jwks;
  }

  return async (c, next) => {
    const authHeader = c.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }
    const token = authHeader.slice(7);

    let claims: { iss?: string; aud?: string | string[] };
    try {
      claims = decodeJwt(token);
    } catch {
      return c.json({ error: "Invalid JWT" }, 401);
    }

    const iss = claims.iss;
    const aud = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
    if (!iss || !aud) {
      return c.json({ error: "JWT missing iss or aud claims" }, 401);
    }

    const tenant = await lookupTenant(iss, aud);
    if (!tenant) {
      return c.json({ error: "Unknown tenant" }, 401);
    }

    try {
      const jwks = getJwks(tenant.jwksUrl);
      await jwtVerify(token, jwks, { issuer: iss, audience: aud });
    } catch {
      return c.json({ error: "JWT verification failed" }, 401);
    }

    c.set("tenantId", tenant.id);
    await next();
  };
}
