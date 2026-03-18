import type {
  TransitionRecord,
  EventLogEntry,
  StepInfo,
  EffectStatus,
  SerializedStateNode,
} from "@durable-machines/machine";
import type { StateValue } from "xstate";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ActivityEntry {
  kind: "transition" | "self-transition" | "unmatched-event";
  ts: number;

  // Transition fields
  from?: StateValue | null;
  to?: StateValue;
  event?: string | null;

  // Correlated data
  eventPayload?: unknown;
  step?: {
    name: string;
    durationMs: number | null;
    output?: unknown;
    error?: unknown;
  };
  effects?: {
    effectType: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    lastError?: string;
  }[];
  contextDiff?: { key: string; before: unknown; after: unknown }[];
  guard?: string;

  // Unmatched-event fields
  eventType?: string;
  payload?: unknown;
  seq?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function stateValuesEqual(
  a: StateValue | null | undefined,
  b: StateValue | null | undefined,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffContext(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): { key: string; before: unknown; after: unknown }[] | undefined {
  if (!before || !after) return undefined;
  const diffs: { key: string; before: unknown; after: unknown }[] = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let count = 0;
  for (const key of allKeys) {
    if (count >= 20) break;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      diffs.push({ key, before: before[key], after: after[key] });
      count++;
    }
  }
  return diffs.length > 0 ? diffs : undefined;
}

// ── Build Feed ──────────────────────────────────────────────────────────────

export interface BuildActivityFeedInput {
  transitions: TransitionRecord[];
  eventLog: EventLogEntry[];
  steps: StepInfo[];
  effects?: EffectStatus[];
  machineStates?: Record<string, SerializedStateNode>;
}

export function buildActivityFeed(input: BuildActivityFeedInput): ActivityEntry[] {
  const { transitions, eventLog, steps, effects, machineStates } = input;
  const entries: ActivityEntry[] = [];

  // Track which event_log entries get correlated
  const matchedEventSeqs = new Set<number>();

  // Build transition entries
  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i];
    const isSelf = t.from != null && stateValuesEqual(t.from, t.to);

    const entry: ActivityEntry = {
      kind: isSelf ? "self-transition" : "transition",
      ts: t.ts,
      from: t.from,
      to: t.to,
      event: t.event,
    };

    // Correlate triggering event: match event type in payload.type + closest timestamp
    if (t.event) {
      let bestMatch: EventLogEntry | null = null;
      let bestDelta = Infinity;
      for (const evt of eventLog) {
        const evtType = (evt.payload as Record<string, unknown>)?.type;
        if (evtType === t.event && !matchedEventSeqs.has(evt.seq)) {
          const delta = Math.abs(evt.createdAt - t.ts);
          if (delta < bestDelta) {
            bestDelta = delta;
            bestMatch = evt;
          }
        }
      }
      if (bestMatch) {
        entry.eventPayload = bestMatch.payload;
        matchedEventSeqs.add(bestMatch.seq);
      }
    }

    // Correlate step: find step whose completion aligns with this transition
    for (const s of steps) {
      if (s.completedAtEpochMs != null && s.startedAtEpochMs != null) {
        if (Math.abs(s.completedAtEpochMs - t.ts) < 100) {
          entry.step = {
            name: s.name,
            durationMs: s.completedAtEpochMs - s.startedAtEpochMs,
            output: s.output,
            error: s.error,
          };
          break;
        }
      }
    }

    // Correlate effects: match effect.stateValue to transition's from state
    if (effects && t.from != null) {
      const matched = effects.filter(
        (eff) => eff.stateValue != null && stateValuesEqual(eff.stateValue, t.from),
      );
      if (matched.length > 0) {
        entry.effects = matched.map((eff) => ({
          effectType: eff.effectType,
          status: eff.status,
          attempts: eff.attempts,
          maxAttempts: eff.maxAttempts,
          ...(eff.lastError != null && { lastError: eff.lastError }),
        }));
      }
    }

    // Context diff from transition snapshots
    if (i > 0 && transitions[i - 1].contextSnapshot && t.contextSnapshot) {
      entry.contextDiff = diffContext(
        transitions[i - 1].contextSnapshot!,
        t.contextSnapshot!,
      );
    }

    // Guard label: look up from machine definition
    if (machineStates && t.from != null && t.event) {
      const fromPath = stateValueStr(t.from);
      const toPath = stateValueStr(t.to);
      const fromNode = machineStates[fromPath];
      const rules = fromNode?.on?.[t.event];
      const match = rules?.find((r) => r.target === toPath);
      if (match?.guard) {
        entry.guard = match.guard;
      }
    }

    entries.push(entry);
  }

  // Collect unmatched events
  for (const evt of eventLog) {
    if (!matchedEventSeqs.has(evt.seq)) {
      const evtType = (evt.payload as Record<string, unknown>)?.type;
      entries.push({
        kind: "unmatched-event",
        ts: evt.createdAt,
        eventType: typeof evtType === "string" ? evtType : evt.topic,
        payload: evt.payload,
        seq: evt.seq,
      });
    }
  }

  // Sort chronologically
  entries.sort((a, b) => a.ts - b.ts);
  return entries;
}

// ── HTML Rendering ──────────────────────────────────────────────────────────

function esc(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function stateValueStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null) {
    return Object.entries(v)
      .map(([k, val]) => `${k}.${stateValueStr(val)}`)
      .join(", ");
  }
  return String(v);
}

function renderDetail(entry: ActivityEntry): string {
  const sections: string[] = [];

  if (entry.event) {
    sections.push(
      `<div class="af-detail-line"><span class="af-detail-label">Trigger</span><span class="af-detail-val">${esc(entry.event)}</span></div>`,
    );
  }

  if (entry.eventPayload) {
    sections.push(
      `<div class="af-detail-section"><div class="af-section-head" style="color:var(--purple)">Event payload</div><div class="af-json">${esc(JSON.stringify(entry.eventPayload, null, 2))}</div></div>`,
    );
  }

  if (entry.step) {
    const s = entry.step;
    const durStr = s.durationMs != null ? formatDuration(s.durationMs) : "—";
    let stepHtml = `<div class="af-detail-section"><div class="af-section-head" style="color:var(--green)">Step: ${esc(s.name)}</div>`;
    stepHtml += `<div class="af-detail-line"><span class="af-detail-label">Duration</span><span class="af-duration">${esc(durStr)}</span></div>`;
    if (s.error != null) {
      const errMsg = typeof s.error === "string" ? s.error : JSON.stringify(s.error, null, 2);
      stepHtml += `<div class="af-error-box">${esc(errMsg)}</div>`;
    } else if (s.output != null) {
      stepHtml += `<div class="af-detail-line"><span class="af-detail-label">Output</span><span class="af-detail-val">${esc(JSON.stringify(s.output))}</span></div>`;
    }
    stepHtml += `</div>`;
    sections.push(stepHtml);
  }

  if (entry.effects && entry.effects.length > 0) {
    let effHtml = `<div class="af-detail-section"><div class="af-section-head" style="color:var(--cyan,#5af)">Effects</div>`;
    for (const eff of entry.effects) {
      effHtml += `<div class="af-detail-line">`;
      effHtml += `<span class="af-detail-label">${esc(eff.effectType)}</span>`;
      effHtml += `<span class="badge badge-${esc(eff.status)}">${esc(eff.status)}</span>`;
      if (eff.attempts > 0) {
        effHtml += ` <span class="af-duration">${eff.attempts}/${eff.maxAttempts}</span>`;
      }
      effHtml += `</div>`;
      if (eff.lastError) {
        effHtml += `<div class="af-error-box">${esc(eff.lastError)}</div>`;
      }
    }
    effHtml += `</div>`;
    sections.push(effHtml);
  }

  if (entry.contextDiff && entry.contextDiff.length > 0) {
    let diffHtml = `<div class="af-detail-section"><div class="af-section-head" style="color:var(--text-dim)">Context</div>`;
    for (const d of entry.contextDiff) {
      const before = d.before === undefined ? "—" : JSON.stringify(d.before);
      const after = d.after === undefined ? "—" : JSON.stringify(d.after);
      diffHtml += `<div class="af-diff">${esc(d.key)}: <span class="af-diff-before">${esc(before)}</span> → <span class="af-diff-after">${esc(after)}</span></div>`;
    }
    diffHtml += `</div>`;
    sections.push(diffHtml);
  }

  return sections.join("");
}

export function renderActivityFeed(feed: ActivityEntry[]): string {
  if (feed.length === 0) {
    return `<div class="empty">No activity yet</div>`;
  }

  let html = "";
  for (const entry of feed) {
    if (entry.kind === "unmatched-event") {
      html += `<div class="af-row af-unmatched">`;
      html += `<span class="af-dot af-dot-event"></span>`;
      html += `<span class="af-event-type">${esc(entry.eventType ?? "event")}</span>`;
      html += `<span class="af-tag af-tag-ignored">no transition</span>`;
      html += `<span class="af-ts">${formatTime(entry.ts)}</span>`;
      html += `</div>`;
      continue;
    }

    const hasDetail = entry.event || entry.step || entry.eventPayload || entry.effects || entry.contextDiff;
    const dotClass = entry.kind === "self-transition" ? "af-dot-self" : "af-dot-transition";

    if (hasDetail) {
      html += `<details class="af-entry">`;
      html += `<summary class="af-row">`;
    } else {
      html += `<div class="af-row">`;
    }

    html += `<span class="af-dot ${dotClass}"></span>`;

    if (entry.kind === "self-transition") {
      html += `<span class="af-state af-self">${esc(stateValueStr(entry.to))}</span>`;
      html += `<span class="af-tag af-tag-self">self</span>`;
    } else {
      if (entry.from != null) {
        html += `<span class="af-state">${esc(stateValueStr(entry.from))} → ${esc(stateValueStr(entry.to))}</span>`;
      } else {
        html += `<span class="af-state">→ ${esc(stateValueStr(entry.to))}</span>`;
      }
    }

    if (entry.event && !entry.event.startsWith("xstate.")) {
      html += `<span class="af-tag af-tag-event">${esc(entry.event)}</span>`;
    }
    if (entry.guard) {
      html += `<span class="af-tag af-tag-guard">${esc(entry.guard)}</span>`;
    }
    if (entry.step) {
      const s = entry.step;
      html += `<span class="af-tag af-tag-step">${esc(s.name)}</span>`;
      if (s.error != null) {
        html += `<span class="af-tag af-tag-error">error</span>`;
      } else if (s.durationMs != null) {
        html += `<span class="af-tag af-tag-done">${formatDuration(s.durationMs)}</span>`;
      }
    }
    if (entry.effects && entry.effects.length > 0) {
      html += `<span class="af-tag af-tag-effect">${entry.effects.length} effect${entry.effects.length > 1 ? "s" : ""}</span>`;
    }

    html += `<span class="af-ts">${formatTime(entry.ts)}</span>`;

    if (hasDetail) {
      html += `</summary>`;
      html += `<div class="af-detail">${renderDetail(entry)}</div>`;
      html += `</details>`;
    } else {
      html += `</div>`;
    }
  }
  return html;
}
