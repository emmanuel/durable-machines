import type { Context } from "hono";
import type { GatewayMetrics } from "./metrics.js";

/** Minimal XState event — no dependency on xstate package. */
export interface XStateEvent {
  /** Event type string, e.g. `"stripe.invoice.paid"`. */
  type: string;
  /** Arbitrary event data. */
  [key: string]: unknown;
}

/** Raw request data passed to sources for verification and parsing. */
export interface RawRequest {
  /** Header map (lowercase keys). Values are `undefined` when absent. */
  headers: Record<string, string | undefined>;
  /** Raw request body as a UTF-8 string. */
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

/** Resolves a parsed payload to one or more target workflow IDs. */
export interface WebhookRouter<TPayload> {
  /** Returns workflow ID(s) to dispatch to, or `null` if no target is found. */
  route(payload: TPayload): RouteResult | Promise<RouteResult>;
}

/** Maps a parsed payload to an XState event. */
export interface WebhookTransform<TPayload> {
  /** Converts a provider-specific payload into an XState-compatible event. */
  transform(payload: TPayload): XStateEvent;
}

/** Wires a source, router, and transform to a URL path. */
export interface WebhookBinding<TPayload = unknown> {
  /** URL path this binding is mounted on (e.g. `"/webhooks/stripe"`). */
  path: string;
  /** Verifies and parses incoming requests for this provider. */
  source: WebhookSource<TPayload>;
  /** Determines which workflow(s) receive the event. */
  router: WebhookRouter<TPayload>;
  /** Converts the parsed payload into an XState event. */
  transform: WebhookTransform<TPayload>;
  /** Optional hook to send an inline response (e.g. Slack slash command ack). */
  onResponse?: (payload: TPayload, c: Context) => Response | Promise<Response> | null;
}

/** Minimal subset of DBOSClient used by the gateway. */
export interface GatewayClient {
  /** Sends a message to a running workflow on the given topic. */
  send<T>(workflowId: string, message: T, topic: string): Promise<void>;
  /** Retrieves a named event from a workflow, with optional timeout. */
  getEvent<T>(workflowId: string, key: string, timeoutSeconds?: number): Promise<T | null>;
}

/** Options for {@link createWebhookGateway}. */
export interface GatewayOptions {
  /** DBOS client instance used to dispatch events to workflows. */
  client: GatewayClient;
  /** Webhook bindings to register on the gateway. */
  bindings: WebhookBinding<any>[];
  /** Optional base path prefix for all bindings (e.g. `"/api"`). */
  basePath?: string;
  /** Optional metrics instance for Prometheus instrumentation. */
  metrics?: GatewayMetrics;
}

/**
 * Thrown when webhook signature verification fails. Maps to HTTP 401.
 */
export class WebhookVerificationError extends Error {
  /**
   * @param message - Human-readable error description.
   * @param source - Provider name (e.g. `"stripe"`, `"github"`) for diagnostics.
   */
  constructor(message: string, public readonly source?: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/**
 * Thrown when routing fails or returns null. Maps to HTTP 422.
 */
export class WebhookRoutingError extends Error {
  /** @param message - Human-readable error description. */
  constructor(message: string) {
    super(message);
    this.name = "WebhookRoutingError";
  }
}
