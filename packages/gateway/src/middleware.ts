import { createMiddleware } from "hono/factory";

type RawBodyEnv = {
  Variables: {
    rawBody: string;
  };
};

/** Default max request body size: 1 MB. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/**
 * Hono middleware that reads the request body as text before any parsing
 * and stores it in `c.get("rawBody")` for HMAC verification.
 *
 * @param opts.maxBodyBytes - Maximum allowed body size in bytes (default 1 MB).
 *   Returns HTTP 413 if exceeded.
 */
export function rawBody(opts?: { maxBodyBytes?: number }) {
  const limit = opts?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return createMiddleware<RawBodyEnv>(async (c, next) => {
    const contentLength = c.req.header("content-length");
    if (contentLength && parseInt(contentLength, 10) > limit) {
      return c.json({ error: "Payload too large" }, 413);
    }
    const body = await c.req.text();
    if (Buffer.byteLength(body, "utf-8") > limit) {
      return c.json({ error: "Payload too large" }, 413);
    }
    c.set("rawBody", body);
    await next();
  });
}
