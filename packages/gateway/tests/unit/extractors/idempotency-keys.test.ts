import { describe, it, expect } from "vitest";
import {
  stripeIdempotencyKey,
  githubIdempotencyKey,
  twilioIdempotencyKey,
  calcomIdempotencyKey,
  xapiIdempotencyKey,
  linearIdempotencyKey,
  actionLinkIdempotencyKey,
  xapiStreamIdempotencyKey,
} from "../../../src/extractors/idempotency-keys.js";
import type { RawRequest } from "../../../src/types.js";

describe("idempotency key extractors", () => {
  describe("stripeIdempotencyKey", () => {
    it("returns event id", () => {
      expect(stripeIdempotencyKey({ id: "evt_123", type: "invoice.paid" } as any)).toBe("evt_123");
    });
  });

  describe("githubIdempotencyKey", () => {
    it("returns deliveryId", () => {
      expect(githubIdempotencyKey({ deliveryId: "abc-def", event: "push", payload: {} } as any)).toBe("abc-def");
    });
  });

  describe("twilioIdempotencyKey", () => {
    it("returns MessageSid", () => {
      expect(twilioIdempotencyKey({ MessageSid: "SM123" } as any)).toBe("SM123");
    });
  });

  describe("calcomIdempotencyKey", () => {
    it("returns payload.uid", () => {
      expect(calcomIdempotencyKey({
        triggerEvent: "BOOKING_CREATED",
        createdAt: "2024-01-01",
        payload: { uid: "booking-xyz" },
      } as any)).toBe("booking-xyz");
    });

    it("returns undefined when uid is absent", () => {
      expect(calcomIdempotencyKey({
        triggerEvent: "BOOKING_CREATED",
        createdAt: "2024-01-01",
        payload: {},
      } as any)).toBeUndefined();
    });
  });

  describe("xapiIdempotencyKey", () => {
    it("returns statement id when present", () => {
      expect(xapiIdempotencyKey({ id: "stmt-uuid", actor: {}, verb: { id: "verb" } } as any)).toBe("stmt-uuid");
    });

    it("returns undefined when id is absent", () => {
      expect(xapiIdempotencyKey({ actor: {}, verb: { id: "verb" } } as any)).toBeUndefined();
    });
  });

  describe("linearIdempotencyKey", () => {
    it("returns composite key from data.id + action + createdAt", () => {
      const result = linearIdempotencyKey({
        action: "create",
        type: "Issue",
        data: { id: "issue-1" },
        createdAt: "2024-01-01T00:00:00Z",
        webhookTimestamp: 1704067200000,
      });
      expect(result).toBe("issue-1:create:2024-01-01T00:00:00Z");
    });

    it("returns undefined when data.id is absent", () => {
      const result = linearIdempotencyKey({
        action: "create",
        type: "Issue",
        data: {},
        createdAt: "2024-01-01T00:00:00Z",
        webhookTimestamp: 1704067200000,
      });
      expect(result).toBeUndefined();
    });
  });

  describe("actionLinkIdempotencyKey", () => {
    it("returns x-action-link-signature header", () => {
      const req: RawRequest = {
        headers: { "x-action-link-signature": "hmac-abc" },
        body: "{}",
      };
      expect(actionLinkIdempotencyKey({ workflowId: "wf-1", event: "APPROVE" }, req)).toBe("hmac-abc");
    });

    it("returns undefined when header is absent", () => {
      const req: RawRequest = { headers: {}, body: "{}" };
      expect(actionLinkIdempotencyKey({ workflowId: "wf-1", event: "APPROVE" }, req)).toBeUndefined();
    });
  });

  describe("xapiStreamIdempotencyKey", () => {
    it("returns statement id when present", () => {
      const result = xapiStreamIdempotencyKey(
        { id: "stmt-123", actor: {}, verb: { id: "http://example.com/verb" } } as any,
        { lastEventId: "e1" },
      );
      expect(result).toBe("stmt-123");
    });

    it("returns composite fallback when id is absent", () => {
      const result = xapiStreamIdempotencyKey(
        { actor: {}, verb: { id: "http://example.com/completed" } } as any,
        { lastEventId: "e42" },
      );
      expect(result).toBe("e42:http://example.com/completed");
    });
  });
});
