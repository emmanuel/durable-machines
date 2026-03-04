import { createMiddleware } from "hono/factory";

type RawBodyEnv = {
  Variables: {
    rawBody: string;
  };
};

/**
 * Hono middleware that reads the request body as text before any parsing
 * and stores it in `c.get("rawBody")` for HMAC verification.
 */
export function rawBody() {
  return createMiddleware<RawBodyEnv>(async (c, next) => {
    const body = await c.req.text();
    c.set("rawBody", body);
    await next();
  });
}
