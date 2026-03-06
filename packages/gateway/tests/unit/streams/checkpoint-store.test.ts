import { describe, it, expect, vi } from "vitest";
import { memoryCheckpointStore, pgCheckpointStore } from "../../../src/streams/checkpoint-store.js";

describe("memoryCheckpointStore", () => {
  it("returns null for unknown stream", async () => {
    const store = memoryCheckpointStore();
    expect(await store.load("unknown")).toBeNull();
  });

  it("save/load roundtrip", async () => {
    const store = memoryCheckpointStore();
    const cursor = { lastEventId: "42", since: "2024-01-01T00:00:00Z" };
    await store.save("stream-1", cursor);
    expect(await store.load("stream-1")).toEqual(cursor);
  });

  it("overwrites previous cursor", async () => {
    const store = memoryCheckpointStore();
    await store.save("stream-1", { offset: 10 });
    await store.save("stream-1", { offset: 20 });
    expect(await store.load("stream-1")).toEqual({ offset: 20 });
  });

  it("stores opaque cursor as-is", async () => {
    const store = memoryCheckpointStore();
    const cursor = { offsets: { 0: "100", 1: "200" }, custom: true };
    await store.save("kafka-topic", cursor);
    expect(await store.load("kafka-topic")).toEqual(cursor);
  });

  it("isolates different stream IDs", async () => {
    const store = memoryCheckpointStore();
    await store.save("a", { pos: 1 });
    await store.save("b", { pos: 2 });
    expect(await store.load("a")).toEqual({ pos: 1 });
    expect(await store.load("b")).toEqual({ pos: 2 });
  });
});

describe("pgCheckpointStore", () => {
  function createMockPool() {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    return {
      queries,
      query: vi.fn(async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      }),
    };
  }

  it("ensureTable() runs CREATE TABLE IF NOT EXISTS", async () => {
    const pool = createMockPool();
    const store = pgCheckpointStore(pool);
    await store.ensureTable();

    expect(pool.query).toHaveBeenCalledOnce();
    const sql = pool.queries[0].text;
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS stream_checkpoints");
    expect(sql).toContain("stream_id TEXT PRIMARY KEY");
    expect(sql).toContain("cursor JSONB NOT NULL");
  });

  it("save() serializes cursor as JSONB", async () => {
    const pool = createMockPool();
    const store = pgCheckpointStore(pool);
    const cursor = { lastEventId: "99", since: "2024-06-01T00:00:00Z" };
    await store.save("my-stream", cursor);

    expect(pool.query).toHaveBeenCalledOnce();
    const { text, values } = pool.queries[0];
    expect(text).toContain("INSERT INTO stream_checkpoints");
    expect(text).toContain("ON CONFLICT");
    expect(values).toEqual(["my-stream", JSON.stringify(cursor)]);
  });

  it("load() returns null for missing stream", async () => {
    const pool = createMockPool();
    const store = pgCheckpointStore(pool);
    const result = await store.load("nonexistent");

    expect(result).toBeNull();
    expect(pool.query).toHaveBeenCalledOnce();
    const { text, values } = pool.queries[0];
    expect(text).toContain("SELECT cursor FROM stream_checkpoints");
    expect(values).toEqual(["nonexistent"]);
  });

  it("load() deserializes JSONB back to cursor object", async () => {
    const cursor = { lastEventId: "42", since: "2024-01-01T00:00:00Z" };
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ cursor }] });

    const store = pgCheckpointStore(pool);
    const result = await store.load("my-stream");

    expect(result).toEqual(cursor);
  });
});
