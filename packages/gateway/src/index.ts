// Gateway
export { createWebhookGateway } from "./gateway.js";

// REST API
export { createRestApi } from "./rest-api.js";
export type {
  MachineRegistry,
  RestApiOptions,
  HateoasLinks,
  StateResponse,
  ErrorResponse,
  InstanceRef,
} from "./rest-types.js";
export { getAvailableEvents, getAvailableEventSchemas, buildLinks, toStateResponse } from "./hateoas.js";

// Admin server
export { createAdminServer } from "./admin.js";
export type { AdminServerOptions } from "./admin.js";

// Metrics
export { createGatewayMetrics } from "./metrics.js";
export type { GatewayMetrics } from "./metrics.js";

// Lifecycle (generic, backend-agnostic)
export { parseGatewayConfig, createGatewayContext, startGateway } from "./lifecycle.js";
export type { GatewayConfig, GatewayContext, InternalGatewayContext, GatewayContextOptions, GatewayCorsOptions, GatewayStoreAdapter, GatewayHandle } from "./lifecycle.js";

// Durable machine type (re-exported for consumers using MachineRegistry)
export type { DurableMachine } from "@durable-xstate/durable-machine";

// Types
export type {
  XStateEvent,
  RawRequest,
  WebhookSource,
  WebhookRouter,
  WebhookTransform,
  WebhookBinding,
  RouteResult,
  ItemRouter,
  ItemTransform,
  GatewayClient,
  GatewayOptions,
  AuthMiddleware,
  GatewaySecurityOptions,
} from "./types.js";
export { WebhookVerificationError, WebhookRoutingError } from "./types.js";

// HMAC utilities
export { computeHmac, verifyHmac } from "./hmac.js";

// Middleware
export { rawBody } from "./middleware.js";

// Sources
export { genericSource } from "./sources/generic.js";
export type { GenericSourceOptions } from "./sources/generic.js";
export { slackSource } from "./sources/slack.js";
export { slashCommandBinding } from "./sources/slack-slash.js";
export type { SlashCommandConfig } from "./sources/slack-slash.js";
export { stripeSource } from "./sources/stripe.js";
export { githubSource } from "./sources/github.js";
export { linearSource } from "./sources/linear.js";
export { calcomSource } from "./sources/calcom.js";
export { twilioSource } from "./sources/twilio.js";
export { actionLinkSource } from "./sources/action-link.js";
export { xapiSource } from "./sources/xapi.js";
export type { XapiSourceOptions } from "./sources/xapi.js";
export { xapiBinding } from "./sources/xapi-binding.js";
export type { XapiBindingConfig } from "./sources/xapi-binding.js";

// Source types
export type { SlackInteractivePayload, SlackAction, SlackView, SlackSlashCommandPayload } from "./sources/slack-types.js";
export type { StripeWebhookEvent } from "./sources/stripe-types.js";
export type { GitHubWebhookEvent } from "./sources/github-types.js";
export type { LinearWebhookEvent } from "./sources/linear-types.js";
export type { CalcomWebhookEvent, CalcomBookingPayload, CalcomPerson } from "./sources/calcom-types.js";
export type { TwilioInboundSms } from "./sources/twilio-types.js";
export type { ActionLinkPayload } from "./sources/action-link-types.js";
export type {
  XapiStatement,
  XapiWebhookPayload,
  XapiAgent,
  XapiVerb,
  XapiActivity,
  XapiResult,
  XapiContext,
} from "./sources/xapi-types.js";

// Streams
export type {
  Logger,
  StreamTransport,
  StreamMessage,
  StreamCursor,
  StreamBinding,
  CheckpointStore,
} from "./streams/types.js";
export type { StreamConsumerOptions, StreamConsumerHandle } from "./streams/consumer.js";
export { startStreamConsumer } from "./streams/consumer.js";
export { sseTransport } from "./streams/sse-transport.js";
export type { SseTransportOptions } from "./streams/sse-transport.js";
export { memoryCheckpointStore, pgCheckpointStore } from "./streams/checkpoint-store.js";
export { xapiStreamBinding } from "./sources/xapi-stream.js";
export type { XapiStreamBindingConfig } from "./sources/xapi-stream.js";

// Routers
export { fieldRouter } from "./routers/field.js";
export { lookupRouter } from "./routers/lookup.js";
export { broadcastRouter } from "./routers/broadcast.js";

// Transforms
export { directTransform } from "./transforms/direct.js";

// Dashboard
export { createDashboard } from "./dashboard/index.js";
export type { DashboardOptions } from "./dashboard/index.js";
