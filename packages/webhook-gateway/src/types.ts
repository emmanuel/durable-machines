import type { Context } from "hono";

/** Minimal XState event — no dependency on xstate package. */
export interface XStateEvent {
  type: string;
  [key: string]: unknown;
}

/** Raw request data passed to sources for verification and parsing. */
export interface RawRequest {
  headers: Record<string, string | undefined>;
  body: string;
}

/** Verifies and parses incoming webhook payloads. */
export interface WebhookSource<TPayload> {
  /** Throws WebhookVerificationError on failure. */
  verify(req: RawRequest): Promise<void>;
  /** Extracts typed payload from raw request. */
  parse(req: RawRequest): Promise<TPayload>;
}

/** Determines target workflow ID(s) from a parsed payload. */
export type RouteResult = string | string[] | null;

export interface WebhookRouter<TPayload> {
  route(payload: TPayload): RouteResult | Promise<RouteResult>;
}

/** Maps a parsed payload to an XState event. */
export interface WebhookTransform<TPayload> {
  transform(payload: TPayload): XStateEvent;
}

/** Wires a source, router, and transform to a URL path. */
export interface WebhookBinding<TPayload = unknown> {
  path: string;
  source: WebhookSource<TPayload>;
  router: WebhookRouter<TPayload>;
  transform: WebhookTransform<TPayload>;
  /** Optional hook to send an inline response (e.g. Slack slash command ack). */
  onResponse?: (payload: TPayload, c: Context) => Response | Promise<Response> | null;
}

/** Minimal subset of DBOSClient used by the gateway. */
export interface GatewayClient {
  send<T>(workflowId: string, message: T, topic: string): Promise<void>;
  getEvent<T>(workflowId: string, key: string, timeoutSeconds?: number): Promise<T | null>;
}

/** Options for createWebhookGateway(). */
export interface GatewayOptions {
  client: GatewayClient;
  bindings: WebhookBinding<any>[];
  /** Optional base path prefix for all bindings. */
  basePath?: string;
}

/** Thrown when webhook signature verification fails. Maps to 401. */
export class WebhookVerificationError extends Error {
  constructor(message: string, public readonly source?: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/** Thrown when routing fails or returns null. Maps to 422. */
export class WebhookRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookRoutingError";
  }
}
