import type {
  DurableStateSnapshot,
  StepInfo,
  EffectStatus,
  TransitionRecord,
  StateDuration,
} from "@durable-xstate/durable-machine";
import { esc, statusBadge, layout } from "./html.js";
import type { InstanceDetailData } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function stateValueStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null) {
    return Object.entries(v)
      .map(([k, val]) => `${k}.${stateValueStr(val)}`)
      .join(", ");
  }
  return String(v);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

// ── Render Helpers ───────────────────────────────────────────────────────────

function renderTimelineEntries(
  transitions: TransitionRecord[],
  durations: StateDuration[],
  activeSleep?: { stateId: string; delay: number; enteredAt: number; wakeAt: number } | null,
): string {
  if (transitions.length === 0) {
    return `<div class="empty">No transitions yet</div>`;
  }

  let html = "";
  for (let i = transitions.length - 1; i >= 0; i--) {
    const t = transitions[i];
    const dur = durations[i];
    const isActive = dur && dur.exitedAt === null;

    html += `<div class="timeline-entry${isActive ? " active" : ""}">
      <div class="timeline-dot"></div>
      <div>
        <div class="timeline-state">${esc(stateValueStr(t.to))}</div>
        ${t.from !== null ? `<div class="timeline-event">from: ${esc(stateValueStr(t.from))}</div>` : ""}
        <div class="timeline-time">${formatTime(t.ts)}</div>
        ${dur ? `<div class="timeline-duration${isActive ? ` active-duration" data-entered="${dur.enteredAt}` : ""}">${formatDuration(dur.durationMs)}</div>` : ""}
        ${isActive && activeSleep ? `<div class="sleep-countdown" data-wake-at="${activeSleep.wakeAt}">${formatDuration(Math.max(0, activeSleep.wakeAt - Date.now()))} remaining</div>` : ""}
      </div>
    </div>`;
  }
  return html;
}

function renderJsonTree(obj: unknown, depth: number): string {
  if (obj === null) return `<span class="json-null">null</span>`;
  if (obj === undefined) return `<span class="json-null">undefined</span>`;

  const t = typeof obj;
  if (t === "string")
    return `<span class="json-string">"${esc(obj)}"</span>`;
  if (t === "number")
    return `<span class="json-number">${obj}</span>`;
  if (t === "boolean")
    return `<span class="json-boolean">${obj}</span>`;

  if (Array.isArray(obj)) {
    if (obj.length === 0)
      return `<span class="json-null">[]</span>`;
    const open = depth < 2 ? " open" : "";
    let html = `<details${open}><summary>[${obj.length} items]</summary>`;
    for (let i = 0; i < obj.length; i++) {
      html += `<div><span class="json-key">${i}</span>: ${renderJsonTree(obj[i], depth + 1)}</div>`;
    }
    return html + "</details>";
  }

  if (t === "object") {
    const keys = Object.keys(obj as Record<string, unknown>);
    if (keys.length === 0)
      return `<span class="json-null">{}</span>`;
    const open = depth < 2 ? " open" : "";
    let html = `<details${open}><summary>{${keys.length} keys}</summary>`;
    for (const k of keys) {
      html += `<div><span class="json-key">${esc(k)}</span>: ${renderJsonTree((obj as Record<string, unknown>)[k], depth + 1)}</div>`;
    }
    return html + "</details>";
  }

  return esc(String(obj));
}

function renderErrorPanel(
  snapshot: DurableStateSnapshot,
  steps: StepInfo[],
  effects?: EffectStatus[],
): string {
  const errors: { source: string; message: string }[] = [];

  if (snapshot.status === "error") {
    const ctx = snapshot.context;
    const errMsg = ctx.error ?? ctx.errorMessage ?? ctx.err;
    if (errMsg != null) {
      errors.push({
        source: "Instance",
        message: typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg, null, 2),
      });
    } else if (errors.length === 0) {
      errors.push({
        source: "Instance",
        message: "Machine reached error status",
      });
    }
  }

  for (const s of steps) {
    if (s.error != null) {
      errors.push({
        source: `Step: ${s.name}`,
        message: typeof s.error === "string" ? s.error : JSON.stringify(s.error, null, 2),
      });
    }
  }

  if (effects) {
    for (const eff of effects) {
      if (eff.status === "failed" && eff.lastError) {
        errors.push({
          source: `Effect: ${eff.effectType}`,
          message: eff.lastError,
        });
      }
    }
  }

  if (errors.length === 0) return "";

  return `<div class="error-panel" id="error-panel">
    <h2>Errors</h2>
    ${errors.map((e) => `
      <div class="error-item">
        <div class="error-item-source">${esc(e.source)}</div>
        <div class="error-item-message">${esc(e.message)}</div>
      </div>`).join("")}
  </div>`;
}

// ── Instance Detail Page ─────────────────────────────────────────────────────

export function instanceDetailPage(
  basePath: string,
  restBasePath: string,
  data: InstanceDetailData,
): string {
  const {
    machineId,
    instanceId,
    snapshot,
    steps,
    graphData,
    transitions,
    stateDurations,
    availableEvents,
    eventSchemas,
    effects,
    eventLog,
    activeStates,
    visitedStates,
    activeSleep,
  } = data;

  const sseUrl = `${basePath}/machines/${machineId}/instances/${instanceId}/stream`;
  const sendUrl = `${restBasePath}/machines/${machineId}/instances/${instanceId}/events`;

  // Graph panel
  const graphPanel = `
    <div class="card graph-panel">
      <h2>State Graph</h2>
      <div id="graph-container"></div>
      <script type="application/json" id="graph-data">${JSON.stringify(graphData)}</script>
      <script type="application/json" id="runtime-data">${JSON.stringify({ activeStates, visitedStates, activeSleep: activeSleep ?? null, eventSchemas: eventSchemas ?? {} })}</script>
    </div>`;

  // Timeline panel
  const timelinePanel = `
    <div class="card timeline-panel">
      <h2>Transition Timeline</h2>
      <div class="timeline" id="timeline-entries">
        ${renderTimelineEntries(transitions, stateDurations, activeSleep)}
      </div>
    </div>`;

  // Context panel
  const contextPanel = `
    <div class="card context-panel">
      <h2>Context</h2>
      <div class="json-tree" id="context-tree">
        ${renderJsonTree(snapshot.context, 0)}
      </div>
    </div>`;

  // Event sender panel
  const eventOptions = availableEvents
    .map((e) => `<option value="${esc(e)}">${esc(e)}</option>`)
    .join("");

  const eventPanel = `
    <div class="card event-panel">
      <h2>Send Event</h2>
      <form id="event-form" class="event-form" action="${esc(sendUrl)}" method="POST">
        <select name="eventType" id="event-type-select">
          <option value="">-- select event --</option>
          ${eventOptions}
        </select>
        <div id="event-fields">
          <textarea name="payload" placeholder='{"key": "value"} (optional)'></textarea>
        </div>
        <button type="submit">Send</button>
        <div class="form-status"></div>
      </form>
    </div>`;

  // Steps panel
  const stepsPanel = steps.length > 0 ? `
    <div class="card">
      <h2>Steps</h2>
      <table>
        <thead><tr><th>Name</th><th>Status</th><th>Duration</th></tr></thead>
        <tbody>
          ${steps.map((s) => {
            const status = s.completedAtEpochMs != null
              ? (s.error != null ? "error" : "done")
              : (s.startedAtEpochMs != null ? "running" : "pending");
            const dur = s.startedAtEpochMs != null && s.completedAtEpochMs != null
              ? formatDuration(s.completedAtEpochMs - s.startedAtEpochMs)
              : s.startedAtEpochMs != null ? "in progress" : "-";
            return `<tr>
              <td class="mono">${esc(s.name)}</td>
              <td>${statusBadge(status)}</td>
              <td class="timeline-duration">${esc(dur)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>` : "";

  // Effects panel
  const effectsPanel = effects ? `
    <div class="card">
      <h2>Effects</h2>
      <div id="effects-list">
        ${effects.length === 0
          ? '<div class="empty">No effects</div>'
          : effects.map((eff) => `
              <div class="effect-row">
                <span class="effect-type">${esc(eff.effectType)}</span>
                ${statusBadge(eff.status)}
                ${eff.attempts > 0 ? `<span class="timeline-duration">${eff.attempts}/${eff.maxAttempts} attempts</span>` : ""}
              </div>`).join("")
        }
      </div>
    </div>` : "";

  // Event log panel
  const eventLogPanel = eventLog ? `
    <div class="card">
      <h2>Event Log</h2>
      <div class="event-log" id="event-log-entries">
        ${eventLog.length === 0
          ? '<div class="empty">No events</div>'
          : eventLog.map((entry) => `
              <div class="event-log-entry">
                <span class="event-log-seq">#${entry.seq}</span>
                <span class="event-log-topic">${esc(entry.topic)}</span>
                <span class="event-log-time">${formatTime(entry.createdAt)}</span>
              </div>`).join("")
        }
      </div>
    </div>` : "";

  // Error panel
  const errorPanel = renderErrorPanel(snapshot, steps, effects);

  const cancelUrl = `${restBasePath}/machines/${machineId}/instances/${instanceId}`;
  const canCancel = snapshot.status === "running";

  const body = `
    <div style="margin-bottom:16px;display:flex;align-items:center;gap:12px">
      <span class="mono" style="font-size:18px;font-weight:600">${esc(instanceId)}</span>
      <span id="instance-status" class="badge badge-${snapshot.status}">${esc(snapshot.status)}</span>
      <button id="cancel-btn" class="btn-danger" data-url="${esc(cancelUrl)}"${canCancel ? "" : " disabled"}>Cancel</button>
      <span id="cancel-status" class="form-status"></span>
    </div>
    <div id="error-panel-container">${errorPanel}</div>
    <div class="detail-grid">
      ${graphPanel}
      ${timelinePanel}
      ${contextPanel}
      ${eventPanel}
    </div>
    ${stepsPanel}
    ${effectsPanel}
    ${eventLogPanel}`;

  return layout(
    {
      title: `${instanceId} - ${machineId} - Dashboard`,
      basePath,
      breadcrumbs: [
        { label: machineId, href: `${basePath}/machines/${machineId}` },
        { label: instanceId },
      ],
      sseUrl,
    },
    body,
  );
}
