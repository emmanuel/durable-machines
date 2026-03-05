// Gateway
export { createWebhookGateway } from "./gateway.js";

// Types
export type {
  XStateEvent,
  RawRequest,
  WebhookSource,
  WebhookRouter,
  WebhookTransform,
  WebhookBinding,
  RouteResult,
  GatewayClient,
  GatewayOptions,
} from "./types.js";
export { WebhookVerificationError, WebhookRoutingError } from "./types.js";

// HMAC utilities
export { computeHmac, verifyHmac } from "./hmac.js";

// Middleware
export { rawBody } from "./middleware.js";

// Sources
export { genericSource } from "./sources/generic.js";
export { slackSource } from "./sources/slack.js";
export { slashCommandBinding } from "./sources/slack-slash.js";
export type { SlashCommandConfig } from "./sources/slack-slash.js";
export { stripeSource } from "./sources/stripe.js";
export { githubSource } from "./sources/github.js";
export { linearSource } from "./sources/linear.js";
export { calcomSource } from "./sources/calcom.js";

// Source types
export type { SlackInteractivePayload, SlackAction, SlackView, SlackSlashCommandPayload } from "./sources/slack-types.js";
export type { StripeWebhookEvent } from "./sources/stripe-types.js";
export type { GitHubWebhookEvent } from "./sources/github-types.js";
export type { LinearWebhookEvent } from "./sources/linear-types.js";
export type { CalcomWebhookEvent, CalcomBookingPayload, CalcomPerson } from "./sources/calcom-types.js";

// Routers
export { fieldRouter } from "./routers/field.js";
export { lookupRouter } from "./routers/lookup.js";
export { broadcastRouter } from "./routers/broadcast.js";

// Transforms
export { directTransform } from "./transforms/direct.js";
