import { randomUUID } from "node:crypto";
import type {
  WebhookBinding,
  ItemRouter,
  ItemTransform,
} from "../types.js";
import { xapiSource } from "./xapi.js";
import type { XapiSourceOptions } from "./xapi.js";
import type { XapiStatement, XapiWebhookPayload } from "./xapi-types.js";

/** Configuration for an xAPI webhook binding. */
export interface XapiBindingConfig {
  /** URL path to mount (e.g. `"/webhooks/xapi"`). */
  path: string;
  /** xAPI source options (auth, version requirement). */
  source: XapiSourceOptions;
  /** Per-statement router — determines which workflow receives each statement. */
  router: ItemRouter<XapiStatement>;
  /** Per-statement transform — converts each statement to an XState event. */
  transform: ItemTransform<XapiStatement>;
}

/**
 * Creates a complete xAPI webhook binding with per-statement fan-out.
 *
 * Each statement is individually routed and dispatched, allowing a single POST
 * containing statements for different workflows to fan out correctly.
 *
 * The `onResponse` handler returns a `200` with a JSON array of statement IDs
 * (per the xAPI spec), generating UUIDs for any statements that lack an `id`.
 * Per-statement routing and dispatch proceed fire-and-forget in the background.
 *
 * @param config - Binding configuration.
 * @returns A {@link WebhookBinding} for xAPI statement webhooks.
 */
export function xapiBinding(
  config: XapiBindingConfig,
): WebhookBinding<XapiWebhookPayload, XapiStatement> {
  const source = xapiSource(config.source);

  return {
    path: config.path,
    source,
    parse: (payload) => payload.statements,
    router: config.router,
    transform: config.transform,
    onResponse(payload, c) {
      const ids = payload.statements.map((s) => s.id ?? randomUUID());
      return c.json(ids, 200);
    },
  };
}
