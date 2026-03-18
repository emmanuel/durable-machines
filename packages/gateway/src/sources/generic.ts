import type { Logger } from "@durable-machines/machine";
import type { WebhookSource, RawRequest } from "../types.js";

export interface GenericSourceOptions {
  logger?: Logger;
}

/**
 * Generic webhook source with no verification.
 * For development and testing only.
 *
 * @returns A {@link WebhookSource} that skips verification and JSON-parses the body.
 */
export function genericSource<TPayload = unknown>(opts?: GenericSourceOptions): WebhookSource<TPayload> {
  const msg = "genericSource() has no webhook verification. Do NOT use in production.";
  if (opts?.logger) {
    opts.logger.warn({}, msg);
  } else {
    console.warn(`[durable-machines] WARNING: ${msg}`);
  }

  return {
    async verify(_req: RawRequest): Promise<void> {
      // No verification — dev/testing only
    },
    async parse(req: RawRequest): Promise<TPayload> {
      return JSON.parse(req.body) as TPayload;
    },
  };
}
