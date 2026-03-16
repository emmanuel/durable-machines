import type { Context, MiddlewareHandler } from "hono";
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

/** Routes a single item to one or more workflow IDs. */
export interface ItemRouter<TItem> {
  /** Returns workflow ID(s) to dispatch to, or `null` to skip this item. */
  route(item: TItem): RouteResult | Promise<RouteResult>;
}

/** Transforms a single item into an XState event. */
export interface ItemTransform<TItem> {
  /** Converts a single item into an XState-compatible event. */
  transform(item: TItem): XStateEvent;
}

/** @deprecated Use {@link ItemRouter} instead. */
export type WebhookRouter<TPayload> = ItemRouter<TPayload>;

/** @deprecated Use {@link ItemTransform} instead. */
export type WebhookTransform<TPayload> = ItemTransform<TPayload>;

/** Wires a source, router, and transform to a URL path. */
export interface WebhookBinding<TPayload = unknown, TItem = TPayload> {
  /** URL path this binding is mounted on (e.g. `"/webhooks/stripe"`). */
  path: string;
  /** Verifies and parses incoming requests for this provider. */
  source: WebhookSource<TPayload>;
  /** Splits a parsed payload into individual items. Defaults to `[payload]` when omitted. */
  parse?: (payload: TPayload) => TItem[];
  /** Determines which workflow(s) receive the event. */
  router: ItemRouter<TItem>;
  /** Converts each item into an XState event. */
  transform: ItemTransform<TItem>;
  /** Optional hook to send an inline response (e.g. Slack slash command ack). */
  onResponse?: (payload: TPayload, c: Context) => Response | Promise<Response> | null;
  /** Tenant ID that scopes this binding. When set, events are dispatched via a tenant-scoped client. */
  tenantId?: string;
  /** Extract a dedup key from a raw request + item. Return undefined to skip dedup. */
  idempotencyKey?: (item: TItem, req: RawRequest) => string | undefined;
}

/** Minimal subset of DBOSClient used by the gateway. */
export interface GatewayClient {
  /** Sends an event to a running workflow. */
  send<T>(workflowId: string, message: T, idempotencyKey?: string): Promise<void>;
  /** Sends a batch of events in a single operation. */
  sendBatch<T>(messages: Array<{ workflowId: string; message: T; idempotencyKey?: string }>): Promise<void>;
  /** Retrieves the current durable state snapshot for a workflow. */
  getState(workflowId: string): Promise<import("@durable-xstate/durable-machine").DurableStateSnapshot | null>;
}

/** Options for {@link createWebhookGateway}. */
export interface GatewayOptions {
  /** Client used to dispatch events to workflows. */
  client: GatewayClient;
  /** Webhook bindings to register on the gateway. */
  bindings: WebhookBinding<any>[];
  /** Optional base path prefix for all bindings (e.g. `"/api"`). */
  basePath?: string;
  /** Optional metrics instance for Prometheus instrumentation. */
  metrics?: GatewayMetrics;
  /** Maximum allowed request body size in bytes (default 1 MB). */
  maxBodyBytes?: number;
  /** Returns a tenant-scoped GatewayClient for bindings with `tenantId`. */
  forTenantClient?: (tenantId: string) => GatewayClient;
}

/** Pluggable auth middleware for gateway routes. */
export type AuthMiddleware = MiddlewareHandler;

/** Security options for the gateway. */
export interface GatewaySecurityOptions {
  /** Auth middleware for REST API routes. */
  restAuth?: AuthMiddleware;
  /** Auth middleware for dashboard routes (pages and SSE streams). */
  dashboardAuth?: AuthMiddleware;
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
