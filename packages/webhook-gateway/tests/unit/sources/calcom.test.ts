import { describe, it, expect } from "vitest";
import { calcomSource } from "../../../src/sources/calcom.js";
import { computeHmac } from "../../../src/hmac.js";
import { WebhookVerificationError } from "../../../src/types.js";

const SECRET = "calcom-webhook-secret";

function makeCalcomRequest(body: string) {
  const sig = computeHmac("sha256", SECRET, body);
  return {
    headers: { "x-cal-signature-256": sig },
    body,
  };
}

describe("calcomSource", () => {
  const source = calcomSource(SECRET);

  it("verifies valid signature", async () => {
    const body = JSON.stringify({
      triggerEvent: "BOOKING_CREATED",
      createdAt: "2025-01-15T10:00:00Z",
      payload: { uid: "abc-123", title: "Meeting" },
    });
    const req = makeCalcomRequest(body);
    await expect(source.verify(req)).resolves.toBeUndefined();
  });

  it("rejects missing header", async () => {
    await expect(
      source.verify({ headers: {}, body: "{}" }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects bad signature", async () => {
    await expect(
      source.verify({
        headers: { "x-cal-signature-256": "a".repeat(64) },
        body: "{}",
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("parses booking event payload", async () => {
    const body = JSON.stringify({
      triggerEvent: "BOOKING_CREATED",
      createdAt: "2025-01-15T10:00:00Z",
      payload: {
        uid: "booking-456",
        bookingId: 42,
        title: "Strategy Call",
        startTime: "2025-01-16T14:00:00Z",
        endTime: "2025-01-16T15:00:00Z",
        status: "ACCEPTED",
        organizer: { name: "Alice", email: "alice@example.com" },
        attendees: [{ name: "Bob", email: "bob@example.com" }],
      },
    });
    const req = makeCalcomRequest(body);
    const result = await source.parse(req);
    expect(result.triggerEvent).toBe("BOOKING_CREATED");
    expect(result.payload.uid).toBe("booking-456");
    expect(result.payload.bookingId).toBe(42);
    expect(result.payload.organizer?.name).toBe("Alice");
    expect(result.payload.attendees?.[0]?.email).toBe("bob@example.com");
  });

  it("parses cancellation event", async () => {
    const body = JSON.stringify({
      triggerEvent: "BOOKING_CANCELLED",
      createdAt: "2025-01-15T12:00:00Z",
      payload: { uid: "booking-789", status: "CANCELLED" },
    });
    const req = makeCalcomRequest(body);
    const result = await source.parse(req);
    expect(result.triggerEvent).toBe("BOOKING_CANCELLED");
    expect(result.payload.status).toBe("CANCELLED");
  });
});
