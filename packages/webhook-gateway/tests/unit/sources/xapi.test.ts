import { describe, it, expect } from "vitest";
import { xapiSource } from "../../../src/sources/xapi.js";
import { WebhookVerificationError } from "../../../src/types.js";
import type { RawRequest } from "../../../src/types.js";

function basicAuth(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

describe("xapiSource", () => {
  describe("Basic Auth", () => {
    const source = xapiSource({
      credentials: { username: "lrs-user", password: "s3cret" },
    });

    it("verifies valid credentials", async () => {
      const req: RawRequest = {
        headers: { authorization: basicAuth("lrs-user", "s3cret") },
        body: "{}",
      };
      await expect(source.verify(req)).resolves.toBeUndefined();
    });

    it("rejects missing Authorization header", async () => {
      await expect(
        source.verify({ headers: {}, body: "{}" }),
      ).rejects.toThrow(WebhookVerificationError);
    });

    it("rejects wrong username", async () => {
      const req: RawRequest = {
        headers: { authorization: basicAuth("wrong-user", "s3cret") },
        body: "{}",
      };
      await expect(source.verify(req)).rejects.toThrow("Invalid credentials");
    });

    it("rejects wrong password", async () => {
      const req: RawRequest = {
        headers: { authorization: basicAuth("lrs-user", "wrong-pass") },
        body: "{}",
      };
      await expect(source.verify(req)).rejects.toThrow("Invalid credentials");
    });

    it("rejects Bearer scheme when Basic expected", async () => {
      const req: RawRequest = {
        headers: { authorization: "Bearer some-token" },
        body: "{}",
      };
      await expect(source.verify(req)).rejects.toThrow("Expected Basic");
    });
  });

  describe("Bearer token", () => {
    const source = xapiSource({ bearerToken: "my-oauth-token" });

    it("verifies valid token", async () => {
      const req: RawRequest = {
        headers: { authorization: "Bearer my-oauth-token" },
        body: "{}",
      };
      await expect(source.verify(req)).resolves.toBeUndefined();
    });

    it("rejects missing Authorization header", async () => {
      await expect(
        source.verify({ headers: {}, body: "{}" }),
      ).rejects.toThrow(WebhookVerificationError);
    });

    it("rejects wrong token", async () => {
      const req: RawRequest = {
        headers: { authorization: "Bearer wrong-token" },
        body: "{}",
      };
      await expect(source.verify(req)).rejects.toThrow("Invalid bearer token");
    });

    it("rejects Basic scheme when Bearer expected", async () => {
      const req: RawRequest = {
        headers: { authorization: basicAuth("user", "pass") },
        body: "{}",
      };
      await expect(source.verify(req)).rejects.toThrow("Expected Bearer");
    });
  });

  describe("Custom validateAuth", () => {
    it("delegates to callback", async () => {
      const source = xapiSource({
        validateAuth: async (req) => {
          if (req.headers["x-custom-key"] !== "valid") {
            throw new WebhookVerificationError("Bad custom key", "xapi");
          }
        },
      });

      await expect(
        source.verify({ headers: { "x-custom-key": "valid" }, body: "{}" }),
      ).resolves.toBeUndefined();
    });

    it("propagates errors from callback", async () => {
      const source = xapiSource({
        validateAuth: async () => {
          throw new WebhookVerificationError("Custom rejection", "xapi");
        },
      });

      await expect(
        source.verify({ headers: {}, body: "{}" }),
      ).rejects.toThrow("Custom rejection");
    });
  });

  describe("No auth", () => {
    const source = xapiSource({});

    it("passes with no headers", async () => {
      await expect(
        source.verify({ headers: {}, body: "{}" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("Version header", () => {
    it("does not require version by default", async () => {
      const source = xapiSource({});
      await expect(
        source.verify({ headers: {}, body: "{}" }),
      ).resolves.toBeUndefined();
    });

    it("rejects absent version when required", async () => {
      const source = xapiSource({ requireVersion: true });
      await expect(
        source.verify({ headers: {}, body: "{}" }),
      ).rejects.toThrow("Missing X-Experience-API-Version");
    });

    it("passes when version header present and required", async () => {
      const source = xapiSource({ requireVersion: true });
      await expect(
        source.verify({
          headers: { "x-experience-api-version": "1.0.3" },
          body: "{}",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("parse", () => {
    const source = xapiSource({});

    it("normalizes single statement to array", async () => {
      const statement = {
        actor: { mbox: "mailto:learner@example.com" },
        verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
        object: { id: "http://example.com/activity/1" },
      };
      const result = await source.parse({
        headers: {},
        body: JSON.stringify(statement),
      });
      expect(result.statements).toHaveLength(1);
      expect(result.statements[0].verb.id).toBe(
        "http://adlnet.gov/expapi/verbs/completed",
      );
    });

    it("passes array of statements through", async () => {
      const statements = [
        {
          actor: { mbox: "mailto:a@example.com" },
          verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
          object: { id: "http://example.com/activity/1" },
        },
        {
          actor: { mbox: "mailto:b@example.com" },
          verb: { id: "http://adlnet.gov/expapi/verbs/attempted" },
          object: { id: "http://example.com/activity/2" },
        },
      ];
      const result = await source.parse({
        headers: {},
        body: JSON.stringify(statements),
      });
      expect(result.statements).toHaveLength(2);
    });

    it("extracts version header", async () => {
      const result = await source.parse({
        headers: { "x-experience-api-version": "1.0.3" },
        body: JSON.stringify({
          actor: { mbox: "mailto:a@example.com" },
          verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
          object: { id: "http://example.com/activity/1" },
        }),
      });
      expect(result.version).toBe("1.0.3");
    });

    it("omits version when header absent", async () => {
      const result = await source.parse({
        headers: {},
        body: JSON.stringify({
          actor: { mbox: "mailto:a@example.com" },
          verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
          object: { id: "http://example.com/activity/1" },
        }),
      });
      expect(result.version).toBeUndefined();
    });

    it("preserves all statement fields", async () => {
      const statement = {
        id: "12345678-1234-1234-1234-123456789abc",
        actor: { mbox: "mailto:learner@example.com", name: "Learner" },
        verb: {
          id: "http://adlnet.gov/expapi/verbs/completed",
          display: { "en-US": "completed" },
        },
        object: {
          id: "http://example.com/course/101",
          definition: {
            name: { "en-US": "Intro to Testing" },
            type: "http://adlnet.gov/expapi/activities/course",
          },
        },
        result: { score: { scaled: 0.95 }, completion: true, success: true },
        context: { registration: "reg-uuid-here" },
        timestamp: "2025-01-15T10:00:00Z",
      };
      const result = await source.parse({
        headers: {},
        body: JSON.stringify(statement),
      });
      const s = result.statements[0];
      expect(s.id).toBe("12345678-1234-1234-1234-123456789abc");
      expect(s.actor.name).toBe("Learner");
      expect(s.result?.score?.scaled).toBe(0.95);
      expect(s.result?.completion).toBe(true);
      expect(s.context?.registration).toBe("reg-uuid-here");
    });
  });
});
