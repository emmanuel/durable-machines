import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { xapiStreamBinding } from "../../../src/sources/xapi-stream.js";
import type { XapiStatement } from "../../../src/sources/xapi-types.js";
import type { Logger } from "../../../src/streams/types.js";

function createLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const sampleStatement: XapiStatement = {
  id: "stmt-1",
  actor: { mbox: "mailto:learner@example.com" },
  verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
  object: { id: "http://example.com/activity/1" },
  context: { registration: "wf-abc" },
};

describe("xapiStreamBinding", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses single statement from SSE data string", () => {
    const binding = xapiStreamBinding({
      url: "http://lrs.example.com/xapi/statements/stream",
      auth: { bearer: "token" },
      router: { route: () => "wf-1" },
      transform: { transform: (s) => ({ type: "xapi.statement", statement: s }) },
      logger: createLogger(),
    });

    const items = binding.parse(JSON.stringify(sampleStatement));
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("stmt-1");
    expect(items[0].verb.id).toContain("completed");
  });

  it("parses array of statements from SSE data string", () => {
    const binding = xapiStreamBinding({
      url: "http://lrs.example.com/xapi/statements/stream",
      auth: { bearer: "token" },
      router: { route: () => "wf-1" },
      transform: { transform: (s) => ({ type: "xapi.statement" }) },
      logger: createLogger(),
    });

    const statements = [sampleStatement, { ...sampleStatement, id: "stmt-2" }];
    const items = binding.parse(JSON.stringify(statements));
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("stmt-1");
    expect(items[1].id).toBe("stmt-2");
  });

  it("returns empty array for empty/whitespace data (heartbeat)", () => {
    const binding = xapiStreamBinding({
      url: "http://lrs.example.com/xapi/statements/stream",
      auth: { bearer: "token" },
      router: { route: () => "wf-1" },
      transform: { transform: (s) => ({ type: "xapi.statement" }) },
      logger: createLogger(),
    });

    expect(binding.parse("")).toEqual([]);
    expect(binding.parse("  ")).toEqual([]);
    expect(binding.parse("\n")).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    const binding = xapiStreamBinding({
      url: "http://lrs.example.com/xapi/statements/stream",
      auth: { bearer: "token" },
      router: { route: () => "wf-1" },
      transform: { transform: (s) => ({ type: "xapi.statement" }) },
      logger: createLogger(),
    });

    expect(binding.parse("not json")).toEqual([]);
  });

  it("routes per-statement via configured router", () => {
    const router = { route: vi.fn((s: XapiStatement) => s.context?.registration ?? null) };
    const binding = xapiStreamBinding({
      url: "http://lrs.example.com/xapi/statements/stream",
      auth: { bearer: "token" },
      router,
      transform: { transform: (s) => ({ type: "xapi.statement" }) },
      logger: createLogger(),
    });

    expect(binding.router).toBe(router);
    expect(binding.router.route(sampleStatement)).toBe("wf-abc");
  });

  it("transforms per-statement via configured transform", () => {
    const transform = {
      transform: vi.fn((s: XapiStatement) => ({
        type: `xapi.${s.verb.id.split("/").pop()}`,
        statement: s,
      })),
    };
    const binding = xapiStreamBinding({
      url: "http://lrs.example.com/xapi/statements/stream",
      auth: { bearer: "token" },
      router: { route: () => "wf-1" },
      transform,
      logger: createLogger(),
    });

    expect(binding.transform).toBe(transform);
    const event = binding.transform.transform(sampleStatement);
    expect(event.type).toBe("xapi.completed");
  });

  it("sets X-Experience-API-Version header on transport", async () => {
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: {}\n\n"));
          controller.close();
        },
      }),
    });

    const binding = xapiStreamBinding({
      url: "http://lrs.example.com/xapi/statements/stream",
      auth: { bearer: "token" },
      router: { route: () => "wf-1" },
      transform: { transform: () => ({ type: "xapi.statement" }) },
      reconnect: { maxRetries: 0, initialBackoffMs: 1 },
      logger: createLogger(),
    });

    const controller = new AbortController();
    for await (const _msg of binding.transport.consume(null, controller.signal)) {
      // consume
    }

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["X-Experience-API-Version"]).toBe("1.0.3");
  });

  it("generates deterministic streamId from URL + filters", () => {
    const binding1 = xapiStreamBinding({
      url: "http://lrs.example.com/xapi/statements/stream",
      auth: { bearer: "token" },
      filter: { verb: "completed", activity: "course-1" },
      router: { route: () => "wf-1" },
      transform: { transform: () => ({ type: "event" }) },
      logger: createLogger(),
    });

    const binding2 = xapiStreamBinding({
      url: "http://lrs.example.com/xapi/statements/stream",
      auth: { bearer: "token" },
      // Same filters in different order
      filter: { activity: "course-1", verb: "completed" },
      router: { route: () => "wf-1" },
      transform: { transform: () => ({ type: "event" }) },
      logger: createLogger(),
    });

    expect(binding1.streamId).toBe(binding2.streamId);
    expect(binding1.streamId).toContain("lrs.example.com");
  });

  it("generates different streamId for different filters", () => {
    const binding1 = xapiStreamBinding({
      url: "http://lrs.example.com/xapi/statements/stream",
      auth: { bearer: "token" },
      filter: { verb: "completed" },
      router: { route: () => "wf-1" },
      transform: { transform: () => ({ type: "event" }) },
      logger: createLogger(),
    });

    const binding2 = xapiStreamBinding({
      url: "http://lrs.example.com/xapi/statements/stream",
      auth: { bearer: "token" },
      filter: { verb: "attempted" },
      router: { route: () => "wf-1" },
      transform: { transform: () => ({ type: "event" }) },
      logger: createLogger(),
    });

    expect(binding1.streamId).not.toBe(binding2.streamId);
  });
});
