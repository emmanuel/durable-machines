import { describe, it, expect } from "vitest";
import { buildActivityFeed, renderActivityFeed } from "../../../src/dashboard/activity-feed.js";
import type { ActivityEntry } from "../../../src/dashboard/activity-feed.js";
import type {
  TransitionRecord,
  EventLogEntry,
  StepInfo,
} from "@durable-xstate/durable-machine";

describe("buildActivityFeed", () => {
  it("creates transition entries from transition records", () => {
    const transitions: TransitionRecord[] = [
      { from: null, to: "idle", event: null, ts: 1000 },
      { from: "idle", to: "active", event: "START", ts: 2000 },
    ];
    const feed = buildActivityFeed({ transitions, eventLog: [], steps: [] });
    expect(feed).toHaveLength(2);
    expect(feed[0].kind).toBe("transition");
    expect(feed[0].from).toBeNull();
    expect(feed[0].to).toBe("idle");
    expect(feed[1].kind).toBe("transition");
    expect(feed[1].event).toBe("START");
  });

  it("marks self-transitions", () => {
    const transitions: TransitionRecord[] = [
      { from: "idle", to: "idle", event: "TICK", ts: 1000 },
    ];
    const feed = buildActivityFeed({ transitions, eventLog: [], steps: [] });
    expect(feed[0].kind).toBe("self-transition");
  });

  it("correlates events to transitions by event type and timestamp", () => {
    const transitions: TransitionRecord[] = [
      { from: "idle", to: "active", event: "START", ts: 2000 },
    ];
    const eventLog: EventLogEntry[] = [
      { seq: 1, topic: "event", payload: { type: "START" }, source: null, createdAt: 1999 },
    ];
    const feed = buildActivityFeed({ transitions, eventLog, steps: [] });
    expect(feed[0].eventPayload).toEqual({ type: "START" });
    expect(feed.filter((e) => e.kind === "unmatched-event")).toHaveLength(0);
  });

  it("shows unmatched events as secondary entries", () => {
    const transitions: TransitionRecord[] = [];
    const eventLog: EventLogEntry[] = [
      { seq: 1, topic: "event", payload: { type: "IGNORED" }, source: null, createdAt: 1000 },
    ];
    const feed = buildActivityFeed({ transitions, eventLog, steps: [] });
    expect(feed).toHaveLength(1);
    expect(feed[0].kind).toBe("unmatched-event");
    expect(feed[0].eventType).toBe("IGNORED");
  });

  it("correlates steps to transitions by timestamp overlap", () => {
    const transitions: TransitionRecord[] = [
      { from: "idle", to: "loading", event: "FETCH", ts: 1000 },
      { from: "loading", to: "done", event: "xstate.done.actor.fetch", ts: 3000 },
    ];
    const steps: StepInfo[] = [
      { name: "fetch", output: { data: 42 }, error: null, startedAtEpochMs: 1000, completedAtEpochMs: 3000 },
    ];
    const feed = buildActivityFeed({ transitions, eventLog: [], steps });
    const doneEntry = feed.find((e) => e.to === "done");
    expect(doneEntry?.step).toBeDefined();
    expect(doneEntry?.step?.name).toBe("fetch");
    expect(doneEntry?.step?.durationMs).toBe(2000);
  });

  it("computes context diffs from consecutive snapshots", () => {
    const transitions: TransitionRecord[] = [
      { from: null, to: "idle", event: null, ts: 1000, contextSnapshot: { count: 0 } },
      { from: "idle", to: "active", event: "START", ts: 2000, contextSnapshot: { count: 1, name: "test" } },
    ];
    const feed = buildActivityFeed({
      transitions, eventLog: [], steps: [],
    });
    expect(feed[1].contextDiff).toEqual([
      { key: "count", before: 0, after: 1 },
      { key: "name", before: undefined, after: "test" },
    ]);
  });

  it("sorts all entries chronologically", () => {
    const transitions: TransitionRecord[] = [
      { from: null, to: "idle", event: null, ts: 1000 },
      { from: "idle", to: "active", event: "START", ts: 3000 },
    ];
    const eventLog: EventLogEntry[] = [
      { seq: 1, topic: "event", payload: { type: "NOISE" }, source: null, createdAt: 2000 },
    ];
    const feed = buildActivityFeed({ transitions, eventLog, steps: [] });
    expect(feed.map((e) => e.ts)).toEqual([1000, 2000, 3000]);
  });
});

describe("renderActivityFeed", () => {
  it("renders transition entries with state change", () => {
    const feed: ActivityEntry[] = [
      { kind: "transition", ts: 1000, from: null, to: "idle", event: null },
      { kind: "transition", ts: 2000, from: "idle", to: "active", event: "START" },
    ];
    const html = renderActivityFeed(feed);
    expect(html).toContain("idle");
    expect(html).toContain("active");
    expect(html).toContain("START");
    expect(html).toContain("<details");
  });

  it("renders self-transitions with self tag", () => {
    const feed: ActivityEntry[] = [
      { kind: "self-transition", ts: 1000, from: "idle", to: "idle", event: "TICK" },
    ];
    const html = renderActivityFeed(feed);
    expect(html).toContain("self");
    expect(html).toContain("TICK");
  });

  it("renders unmatched events as dimmed rows", () => {
    const feed: ActivityEntry[] = [
      { kind: "unmatched-event", ts: 1000, eventType: "IGNORED", seq: 1 },
    ];
    const html = renderActivityFeed(feed);
    expect(html).toContain("unmatched");
    expect(html).toContain("IGNORED");
  });

  it("renders step detail in expanded area", () => {
    const feed: ActivityEntry[] = [{
      kind: "transition", ts: 2000, from: "loading", to: "done",
      event: "xstate.done.actor.fetch",
      step: { name: "fetch", durationMs: 1500, output: { data: 42 }, error: null },
    }];
    const html = renderActivityFeed(feed);
    expect(html).toContain("fetch");
    expect(html).toContain("1.5s");
  });

  it("renders context diff when present", () => {
    const feed: ActivityEntry[] = [{
      kind: "transition", ts: 2000, from: "idle", to: "active", event: "START",
      contextDiff: [{ key: "count", before: 0, after: 1 }],
    }];
    const html = renderActivityFeed(feed);
    expect(html).toContain("count");
    expect(html).toContain("0");
    expect(html).toContain("1");
  });

  it("renders error detail for failed steps", () => {
    const feed: ActivityEntry[] = [{
      kind: "transition", ts: 2000, from: "loading", to: "error",
      event: "xstate.error.actor.fetch",
      step: { name: "fetch", durationMs: 800, output: null, error: "Connection refused" },
    }];
    const html = renderActivityFeed(feed);
    expect(html).toContain("Connection refused");
    expect(html).toContain("error");
  });

  it("returns empty message when feed is empty", () => {
    const html = renderActivityFeed([]);
    expect(html).toContain("No activity");
  });
});
