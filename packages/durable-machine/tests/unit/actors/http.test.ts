import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createActor, waitFor } from "xstate";
import { httpActor, type HttpActorInput } from "../../../src/actors/http.js";

async function runHttpActor(input: HttpActorInput) {
  const actor = createActor(httpActor, { input });
  actor.start();
  const snapshot = await waitFor(actor, (s) => s.status !== "active", {
    timeout: 5000,
  });
  if (snapshot.status === "error") throw snapshot.error;
  return snapshot.output;
}

describe("httpActor", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET request returns JSON response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: "ok" }), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      }),
    );

    const output = await runHttpActor({ url: "http://api.test/resource" });

    expect(output).toEqual({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: { data: "ok" },
    });
  });

  it("POST with object body auto-sets content-type and serialises body", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ created: true }), {
        status: 201,
        statusText: "Created",
        headers: { "content-type": "application/json" },
      }),
    );

    await runHttpActor({
      url: "http://api.test/data",
      method: "POST",
      body: { key: "val" },
    });

    expect(mockFetch).toHaveBeenCalledWith("http://api.test/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"key":"val"}',
      signal: expect.any(AbortSignal),
    });
  });

  it("POST with explicit content-type does not override to application/json", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("accepted", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
      }),
    );

    await runHttpActor({
      url: "http://api.test/data",
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "raw text",
    });

    expect(mockFetch).toHaveBeenCalledWith("http://api.test/data", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "raw text",
      signal: expect.any(AbortSignal),
    });
  });

  it("text response returns body as string", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("hello world", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
      }),
    );

    const output = await runHttpActor({ url: "http://api.test/text" });

    expect(output.body).toBe("hello world");
  });

  it("non-2xx response throws with HTTP status in message", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("Bad Request", {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "text/plain" },
      }),
    );

    await expect(
      runHttpActor({ url: "http://api.test/fail" }),
    ).rejects.toThrow("HTTP 400");
  });

  it("timeout aborts the request", async () => {
    mockFetch.mockImplementationOnce(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          // Simulate real fetch: reject when signal fires
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    await expect(
      runHttpActor({ url: "http://api.test/slow", timeout: 50 }),
    ).rejects.toThrow();
  });
});
