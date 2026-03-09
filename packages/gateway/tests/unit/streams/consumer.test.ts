import { describe, it, expect, vi } from "vitest";
import { startStreamConsumer } from "../../../src/streams/consumer.js";
import { memoryCheckpointStore } from "../../../src/streams/checkpoint-store.js";
import type { StreamBinding, StreamMessage, StreamTransport, Logger, StreamCursor } from "../../../src/streams/types.js";

function createLogger(): Logger & { calls: Record<string, Array<[Record<string, unknown>, string]>> } {
  const calls: Record<string, Array<[Record<string, unknown>, string]>> = {
    info: [], warn: [], error: [], debug: [],
  };
  return {
    calls,
    info(obj, msg) { calls.info.push([obj, msg]); },
    warn(obj, msg) { calls.warn.push([obj, msg]); },
    error(obj, msg) { calls.error.push([obj, msg]); },
    debug(obj, msg) { calls.debug.push([obj, msg]); },
  };
}

function createStringTransport(
  messages: StreamMessage<string>[],
  keepAlive = false,
): StreamTransport<string> & { acknowledged: StreamMessage<string>[]; closed: boolean } {
  const acknowledged: StreamMessage<string>[] = [];
  let closed = false;

  return {
    acknowledged,
    get closed() { return closed; },
    async *consume(_cursor: StreamCursor | null, signal: AbortSignal) {
      for (const msg of messages) {
        if (signal.aborted) return;
        yield msg;
      }
      if (keepAlive) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) { resolve(); return; }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
    async acknowledge(msg: StreamMessage<string>) {
      acknowledged.push(msg);
    },
    async close() {
      closed = true;
    },
  };
}

function createMockClient() {
  const sends: Array<{ workflowId: string; message: unknown }> = [];
  return {
    sends,
    async send(workflowId: string, message: unknown) {
      sends.push({ workflowId, message });
    },
    async sendBatch(messages: Array<{ workflowId: string; message: unknown }>) {
      for (const { workflowId, message } of messages) {
        sends.push({ workflowId, message });
      }
    },
    async getState() { return null; },
  };
}

describe("startStreamConsumer", () => {
  it("dispatches items from transport to client", async () => {
    const transport = createStringTransport([
      { raw: '{"type":"test","value":1}', cursor: { pos: 1 } },
      { raw: '{"type":"test","value":2}', cursor: { pos: 2 } },
    ]);
    const client = createMockClient();
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();

    const binding: StreamBinding<string, { type: string; value: number }> = {
      streamId: "test-stream",
      transport,
      parse: (raw) => [JSON.parse(raw)],
      router: { route: () => "wf-1" },
      transform: { transform: (item) => ({ type: item.type, value: item.value }) },
    };

    const handle = startStreamConsumer(binding, { client, checkpoints, logger });
    await handle.stopped;

    expect(client.sends).toHaveLength(2);
    expect(client.sends[0]).toEqual({ workflowId: "wf-1", message: { type: "test", value: 1 } });
    expect(client.sends[1]).toEqual({ workflowId: "wf-1", message: { type: "test", value: 2 } });
  });

  it("routes per-item (fan-out to different workflows)", async () => {
    const transport = createStringTransport([
      { raw: "batch", cursor: { pos: 1 } },
    ]);
    const client = createMockClient();
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();

    const binding: StreamBinding<string, { id: string; wfId: string }> = {
      streamId: "fanout-stream",
      transport,
      parse: () => [
        { id: "a", wfId: "wf-aaa" },
        { id: "b", wfId: "wf-bbb" },
      ],
      router: { route: (item) => item.wfId },
      transform: { transform: (item) => ({ type: "event", itemId: item.id }) },
    };

    const handle = startStreamConsumer(binding, { client, checkpoints, logger });
    await handle.stopped;

    expect(client.sends).toHaveLength(2);
    expect(client.sends[0].workflowId).toBe("wf-aaa");
    expect(client.sends[1].workflowId).toBe("wf-bbb");
  });

  it("skips items where router returns null", async () => {
    const transport = createStringTransport([
      { raw: "data", cursor: { pos: 1 } },
    ]);
    const client = createMockClient();
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();

    const binding: StreamBinding<string, { routable: boolean }> = {
      streamId: "skip-stream",
      transport,
      parse: () => [{ routable: true }, { routable: false }],
      router: { route: (item) => item.routable ? "wf-1" : null },
      transform: { transform: () => ({ type: "event" }) },
    };

    const handle = startStreamConsumer(binding, { client, checkpoints, logger });
    await handle.stopped;

    expect(client.sends).toHaveLength(1);
    expect(client.sends[0].workflowId).toBe("wf-1");
  });

  it("skips messages where parse returns empty array (heartbeats)", async () => {
    const transport = createStringTransport([
      { raw: "", cursor: { pos: 1 } },
      { raw: "data", cursor: { pos: 2 } },
    ]);
    const client = createMockClient();
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();

    const binding: StreamBinding<string, { v: number }> = {
      streamId: "heartbeat-stream",
      transport,
      parse: (raw) => raw === "" ? [] : [{ v: 1 }],
      router: { route: () => "wf-1" },
      transform: { transform: (item) => ({ type: "event", v: item.v }) },
    };

    const handle = startStreamConsumer(binding, { client, checkpoints, logger });
    await handle.stopped;

    expect(client.sends).toHaveLength(1);
  });

  it("heartbeats do not count toward checkpoint interval", async () => {
    // 3 heartbeats + 1 data message, interval=2
    // Only the data message should count, so no periodic checkpoint fires (only final)
    const messages: StreamMessage<string>[] = [
      { raw: "", cursor: { pos: 0 } },
      { raw: "", cursor: { pos: 1 } },
      { raw: "", cursor: { pos: 2 } },
      { raw: "data", cursor: { pos: 3 } },
    ];
    const transport = createStringTransport(messages);
    const client = createMockClient();
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();
    const saveSpy = vi.spyOn(checkpoints, "save");

    const binding: StreamBinding<string, string> = {
      streamId: "hb-ckpt-stream",
      transport,
      parse: (raw) => raw === "" ? [] : [raw],
      router: { route: () => "wf-1" },
      transform: { transform: (item) => ({ type: item }) },
    };

    const handle = startStreamConsumer(binding, {
      client,
      checkpoints,
      logger,
      checkpointInterval: 2,
    });
    await handle.stopped;

    // Only 1 data message processed → messageCount=1, never hits interval=2
    // Only the final checkpoint should fire
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][1]).toEqual({ pos: 3 });
  });

  it("checkpoints after N messages (configurable interval)", async () => {
    const messages: StreamMessage<string>[] = Array.from({ length: 5 }, (_, i) => ({
      raw: `msg-${i}`,
      cursor: { pos: i },
    }));
    const transport = createStringTransport(messages);
    const client = createMockClient();
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();
    const saveSpy = vi.spyOn(checkpoints, "save");

    const binding: StreamBinding<string, string> = {
      streamId: "ckpt-stream",
      transport,
      parse: (raw) => [raw],
      router: { route: () => "wf-1" },
      transform: { transform: (item) => ({ type: item }) },
    };

    const handle = startStreamConsumer(binding, {
      client,
      checkpoints,
      logger,
      checkpointInterval: 2,
    });
    await handle.stopped;

    // Checkpoints at msg 2, 4 (intervals) + final checkpoint
    // Messages 0,1,2,3,4 → checkpoint at count 2 (pos=1), count 4 (pos=3), final (pos=4)
    const savedCursors = saveSpy.mock.calls.map(([, cursor]) => cursor);
    expect(savedCursors).toContainEqual({ pos: 1 });
    expect(savedCursors).toContainEqual({ pos: 3 });
    // Final checkpoint
    expect(savedCursors[savedCursors.length - 1]).toEqual({ pos: 4 });
  });

  it("saves final checkpoint on stop", async () => {
    const transport = createStringTransport(
      [{ raw: "data", cursor: { pos: 42 } }],
      true, // keepAlive
    );
    const client = createMockClient();
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();

    const binding: StreamBinding<string, string> = {
      streamId: "stop-stream",
      transport,
      parse: (raw) => [raw],
      router: { route: () => "wf-1" },
      transform: { transform: () => ({ type: "event" }) },
    };

    const handle = startStreamConsumer(binding, { client, checkpoints, logger, checkpointInterval: 1000 });

    // Wait for message to be processed
    await new Promise((r) => setTimeout(r, 50));
    handle.stop();
    await handle.stopped;

    const cursor = await checkpoints.load("stop-stream");
    expect(cursor).toEqual({ pos: 42 });
  });

  it("continues on dispatch error for individual items (logs error)", async () => {
    const transport = createStringTransport([
      { raw: "batch", cursor: { pos: 1 } },
    ]);
    const failingClient = {
      sends: [] as Array<{ workflowId: string; message: unknown }>,
      async send(workflowId: string, message: unknown) {
        if (workflowId === "wf-fail") throw new Error("dispatch failed");
        failingClient.sends.push({ workflowId, message });
      },
      async sendBatch() {
        throw new Error("batch dispatch failed");
      },
      async getState() { return null; },
    };
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();

    const binding: StreamBinding<string, { id: string; wfId: string }> = {
      streamId: "error-stream",
      transport,
      parse: () => [
        { id: "fail", wfId: "wf-fail" },
        { id: "ok", wfId: "wf-ok" },
      ],
      router: { route: (item) => item.wfId },
      transform: { transform: (item) => ({ type: "event", id: item.id }) },
    };

    const handle = startStreamConsumer(binding, { client: failingClient, checkpoints, logger });
    await handle.stopped;

    // The "ok" item was still dispatched
    expect(failingClient.sends).toHaveLength(1);
    expect(failingClient.sends[0].workflowId).toBe("wf-ok");
    // Error was logged
    expect(logger.calls.error.length).toBeGreaterThan(0);
    expect(logger.calls.error.some(([obj]) => obj.workflowId === "wf-fail")).toBe(true);
  });

  it("resumes from checkpoint cursor on start", async () => {
    const transport = createStringTransport([
      { raw: "data", cursor: { pos: 2 } },
    ]);
    const client = createMockClient();
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();

    // Pre-save a checkpoint
    await checkpoints.save("resume-stream", { pos: 1 });

    // Track what cursor the transport receives
    let receivedCursor: StreamCursor | null = null;
    const origConsume = transport.consume.bind(transport);
    transport.consume = async function*(cursor: StreamCursor | null, signal: AbortSignal) {
      receivedCursor = cursor;
      yield* origConsume(cursor, signal);
    };

    const binding: StreamBinding<string, string> = {
      streamId: "resume-stream",
      transport,
      parse: (raw) => [raw],
      router: { route: () => "wf-1" },
      transform: { transform: () => ({ type: "event" }) },
    };

    const handle = startStreamConsumer(binding, { client, checkpoints, logger });
    await handle.stopped;

    expect(receivedCursor).toEqual({ pos: 1 });
  });

  it("supports async router", async () => {
    const transport = createStringTransport([
      { raw: '{"key":"abc"}', cursor: { pos: 1 } },
    ]);
    const client = createMockClient();
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();

    const binding: StreamBinding<string, { key: string }> = {
      streamId: "async-router-stream",
      transport,
      parse: (raw) => [JSON.parse(raw)],
      router: {
        async route(item) {
          // Simulate async lookup
          await new Promise((r) => setTimeout(r, 5));
          return `wf-${item.key}`;
        },
      },
      transform: { transform: (item) => ({ type: "event", key: item.key }) },
    };

    const handle = startStreamConsumer(binding, { client, checkpoints, logger });
    await handle.stopped;

    expect(client.sends).toHaveLength(1);
    expect(client.sends[0].workflowId).toBe("wf-abc");
  });

  it("supports multi-target routing (array result)", async () => {
    const transport = createStringTransport([
      { raw: "broadcast", cursor: { pos: 1 } },
    ]);
    const client = createMockClient();
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();

    const binding: StreamBinding<string, string> = {
      streamId: "multi-target-stream",
      transport,
      parse: (raw) => [raw],
      router: { route: () => ["wf-1", "wf-2", "wf-3"] },
      transform: { transform: () => ({ type: "BROADCAST" }) },
    };

    const handle = startStreamConsumer(binding, { client, checkpoints, logger });
    await handle.stopped;

    expect(client.sends).toHaveLength(3);
    expect(client.sends.map((s) => s.workflowId)).toEqual(["wf-1", "wf-2", "wf-3"]);
    expect(client.sends.every((s) => (s.message as any).type === "BROADCAST")).toBe(true);
  });

  it("handles empty stream (transport yields no messages)", async () => {
    const transport = createStringTransport([]);
    const client = createMockClient();
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();

    const binding: StreamBinding<string, string> = {
      streamId: "empty-stream",
      transport,
      parse: (raw) => [raw],
      router: { route: () => "wf-1" },
      transform: { transform: () => ({ type: "event" }) },
    };

    const handle = startStreamConsumer(binding, { client, checkpoints, logger });
    await handle.stopped;

    expect(client.sends).toHaveLength(0);
    expect(transport.closed).toBe(true);
  });

  it("calls transport.close() on stop", async () => {
    const transport = createStringTransport([], true);
    const client = createMockClient();
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();

    const binding: StreamBinding<string, string> = {
      streamId: "close-stream",
      transport,
      parse: (raw) => [raw],
      router: { route: () => "wf-1" },
      transform: { transform: () => ({ type: "event" }) },
    };

    const handle = startStreamConsumer(binding, { client, checkpoints, logger });
    await new Promise((r) => setTimeout(r, 10));
    handle.stop();
    await handle.stopped;

    expect(transport.closed).toBe(true);
  });

  it("logs via provided logger", async () => {
    const transport = createStringTransport([]);
    const client = createMockClient();
    const logger = createLogger();
    const checkpoints = memoryCheckpointStore();

    const binding: StreamBinding<string, string> = {
      streamId: "log-stream",
      transport,
      parse: (raw) => [raw],
      router: { route: () => "wf-1" },
      transform: { transform: () => ({ type: "event" }) },
    };

    const handle = startStreamConsumer(binding, { client, checkpoints, logger });
    await handle.stopped;

    // Should have logged start and stop messages
    expect(logger.calls.info.some(([, msg]) => msg.includes("starting"))).toBe(true);
    expect(logger.calls.info.some(([, msg]) => msg.includes("stopped"))).toBe(true);
  });
});
