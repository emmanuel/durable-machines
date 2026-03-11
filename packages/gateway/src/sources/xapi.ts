import { timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "../types.js";
import type { WebhookSource, RawRequest } from "../types.js";
import type { XapiStatement, XapiWebhookPayload } from "./xapi-types.js";

/** Configuration for the xAPI webhook source. */
export interface XapiSourceOptions {
  /** HTTP Basic Auth credentials (most common for Learning Locker, SCORM Cloud). */
  credentials?: { username: string; password: string };
  /** Bearer token (e.g. LinkedIn Learning OAuth 2.0). */
  bearerToken?: string;
  /** Custom auth callback — throw to reject. */
  validateAuth?: (req: RawRequest) => Promise<void>;
  /** When `true`, rejects requests missing `X-Experience-API-Version` header. */
  requireVersion?: boolean;
}

/**
 * xAPI (Experience API) webhook source.
 *
 * Handles the three common LRS authentication patterns:
 * - HTTP Basic Auth (`credentials`)
 * - Bearer token (`bearerToken`)
 * - Custom callback (`validateAuth`)
 *
 * If none are set, requests pass without auth verification (dev/testing).
 *
 * POST body may be a single statement `{...}` or an array `[{...}, ...]`.
 * The source normalizes both to `{ statements: XapiStatement[] }`.
 *
 * @param options - Source configuration.
 * @returns A {@link WebhookSource} for xAPI statement payloads.
 */
export function xapiSource(options: XapiSourceOptions = {}): WebhookSource<XapiWebhookPayload> {
  const { credentials, bearerToken, validateAuth, requireVersion } = options;

  return {
    async verify(req: RawRequest): Promise<void> {
      // Auth verification
      if (credentials) {
        verifyBasicAuth(req, credentials.username, credentials.password);
      } else if (bearerToken) {
        verifyBearerToken(req, bearerToken);
      } else if (validateAuth) {
        await validateAuth(req);
      } else {
        throw new WebhookVerificationError(
          "No auth configured. Set credentials, bearerToken, or validateAuth. " +
            "For dev mode, pass validateAuth: async () => {}.",
          "xapi",
        );
      }

      // Version header check
      if (requireVersion) {
        const version = req.headers["x-experience-api-version"];
        if (!version) {
          throw new WebhookVerificationError(
            "Missing X-Experience-API-Version header",
            "xapi",
          );
        }
      }
    },

    async parse(req: RawRequest): Promise<XapiWebhookPayload> {
      const parsed: XapiStatement | XapiStatement[] = JSON.parse(req.body);
      const statements = Array.isArray(parsed) ? parsed : [parsed];
      const version = req.headers["x-experience-api-version"];
      return { statements, ...(version ? { version } : {}) };
    },
  };
}

function verifyBasicAuth(req: RawRequest, username: string, password: string): void {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    throw new WebhookVerificationError("Missing Authorization header", "xapi");
  }

  if (!authHeader.startsWith("Basic ")) {
    throw new WebhookVerificationError("Expected Basic authentication scheme", "xapi");
  }

  const encoded = authHeader.slice(6);
  const decoded = Buffer.from(encoded, "base64").toString("utf-8");
  const colonIndex = decoded.indexOf(":");
  if (colonIndex === -1) {
    throw new WebhookVerificationError("Invalid Basic credentials format", "xapi");
  }

  const reqUser = decoded.slice(0, colonIndex);
  const reqPass = decoded.slice(colonIndex + 1);

  const expectedUser = Buffer.from(username, "utf-8");
  const actualUser = Buffer.from(reqUser, "utf-8");
  const expectedPass = Buffer.from(password, "utf-8");
  const actualPass = Buffer.from(reqPass, "utf-8");

  const userMatch = expectedUser.length === actualUser.length &&
    timingSafeEqual(expectedUser, actualUser);
  const passMatch = expectedPass.length === actualPass.length &&
    timingSafeEqual(expectedPass, actualPass);

  if (!userMatch || !passMatch) {
    throw new WebhookVerificationError("Invalid credentials", "xapi");
  }
}

function verifyBearerToken(req: RawRequest, token: string): void {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    throw new WebhookVerificationError("Missing Authorization header", "xapi");
  }

  if (!authHeader.startsWith("Bearer ")) {
    throw new WebhookVerificationError("Expected Bearer authentication scheme", "xapi");
  }

  const reqToken = authHeader.slice(7);
  const expectedBuf = Buffer.from(token, "utf-8");
  const actualBuf = Buffer.from(reqToken, "utf-8");

  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new WebhookVerificationError("Invalid bearer token", "xapi");
  }
}
