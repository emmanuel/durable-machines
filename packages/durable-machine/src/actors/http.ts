import { fromPromise } from "xstate";

export interface HttpActorInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export interface HttpActorOutput {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * Built-in HTTP actor using `fromPromise`.
 *
 * Input: `{ url, method?, headers?, body?, timeout? }`
 * Returns: `{ status, statusText, headers, body }`
 * Throws on non-2xx responses.
 */
export const httpActor = fromPromise<HttpActorOutput, HttpActorInput>(
  async ({ input }) => {
    const { url, method = "GET", headers = {}, body, timeout = DEFAULT_TIMEOUT } = input;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const reqHeaders = { ...headers };
      let reqBody: string | undefined;

      if (body !== undefined) {
        if (typeof body === "object" && body !== null && !reqHeaders["content-type"]) {
          reqHeaders["content-type"] = "application/json";
        }
        reqBody = typeof body === "string" ? body : JSON.stringify(body);
      }

      const response = await fetch(url, {
        method,
        headers: reqHeaders,
        body: reqBody,
        signal: controller.signal,
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const contentType = response.headers.get("content-type") ?? "";
      const isJson = contentType.includes("application/json");
      const responseBody = isJson ? await response.json() : await response.text();

      if (!response.ok) {
        const bodyStr = typeof responseBody === "string"
          ? responseBody
          : JSON.stringify(responseBody);
        throw new Error(
          `HTTP ${response.status} ${response.statusText}: ${bodyStr}`,
        );
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
      };
    } finally {
      clearTimeout(timer);
    }
  },
);
