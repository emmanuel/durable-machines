import { randomUUID } from "node:crypto";
import type {
  WebhookBinding,
  WebhookRouter,
  WebhookTransform,
} from "../types.js";
import { xapiSource } from "./xapi.js";
import type { XapiSourceOptions } from "./xapi.js";
import type { XapiWebhookPayload } from "./xapi-types.js";

/** Configuration for an xAPI webhook binding. */
export interface XapiBindingConfig {
  /** URL path to mount (e.g. `"/webhooks/xapi"`). */
  path: string;
  /** xAPI source options (auth, version requirement). */
  source: XapiSourceOptions;
  /** Determines which workflow(s) receive the event. */
  router: WebhookRouter<XapiWebhookPayload>;
  /** Converts the xAPI payload into an XState event. */
  transform: WebhookTransform<XapiWebhookPayload>;
}

/**
 * Creates a complete xAPI webhook binding.
 *
 * The `onResponse` handler returns a `200` with a JSON array of statement IDs
 * (per the xAPI spec), generating UUIDs for any statements that lack an `id`.
 * Routing and dispatch proceed fire-and-forget in the background.
 *
 * @param config - Binding configuration.
 * @returns A {@link WebhookBinding} for xAPI statement webhooks.
 */
export function xapiBinding(config: XapiBindingConfig): WebhookBinding<XapiWebhookPayload> {
  const source = xapiSource(config.source);

  return {
    path: config.path,
    source,
    router: config.router,
    transform: config.transform,
    onResponse(payload, c) {
      const ids = payload.statements.map((s) => s.id ?? randomUUID());
      return c.json(ids, 200);
    },
  };
}
