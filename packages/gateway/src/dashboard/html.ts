import type {
  DurableMachineStatus,
  DurableStateSnapshot,
  StepInfo,
  EffectStatus,
  EventLogEntry,
  TransitionRecord,
  StateDuration,
} from "@durable-xstate/durable-machine";
import type { GraphData } from "./graph.js";
import { CSS } from "./styles.js";
import { CLIENT_JS } from "./client.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function statusBadge(status: string): string {
  const lower = status.toLowerCase();
  const cls =
    lower === "running" || lower === "pending" ? `badge-${lower}`
    : lower === "done" || lower === "success" ? "badge-done"
    : lower === "error" ? "badge-error"
    : lower === "cancelled" ? "badge-cancelled"
    : "badge-pending";
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

// ── Layout ───────────────────────────────────────────────────────────────────

interface LayoutOptions {
  title: string;
  basePath: string;
  breadcrumbs?: { label: string; href?: string }[];
  sseUrl?: string;
}

export function layout(options: LayoutOptions, body: string): string {
  const { title, basePath, breadcrumbs, sseUrl } = options;

  const breadcrumbHtml = breadcrumbs?.length
    ? `<nav class="breadcrumb">
        <a href="${esc(basePath)}">Dashboard</a>
        ${breadcrumbs.map((b) =>
          b.href
            ? `<span class="sep">/</span><a href="${esc(b.href)}">${esc(b.label)}</a>`
            : `<span class="sep">/</span><span>${esc(b.label)}</span>`,
        ).join("")}
      </nav>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <h1><span>Durable</span> Machines</h1>
    ${breadcrumbHtml}
    ${sseUrl ? `<span class="sse-indicator connecting" title="SSE connection"></span>` : ""}
  </header>
  <main class="container">
    ${body}
  </main>
  ${sseUrl ? `<script type="application/json" id="sse-url">${esc(sseUrl)}</script>` : ""}
  <script>${CLIENT_JS}</script>
</body>
</html>`;
}

// ── Machine List Page ────────────────────────────────────────────────────────

interface MachineListItem {
  machineId: string;
  instanceCount: number;
}

export function machineListPage(
  basePath: string,
  machines: MachineListItem[],
): string {
  let rows = "";
  if (machines.length === 0) {
    rows = `<tr><td colspan="2" class="empty">No machines registered</td></tr>`;
  } else {
    for (const m of machines) {
      rows += `<tr>
        <td class="mono"><a href="${esc(basePath)}/${esc(m.machineId)}">${esc(m.machineId)}</a></td>
        <td>${m.instanceCount}</td>
      </tr>`;
    }
  }

  const body = `
    <div class="card">
      <h2>Registered Machines</h2>
      <table>
        <thead><tr><th>Machine</th><th>Instances</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  return layout({ title: "Dashboard", basePath }, body);
}

// ── Instance List Page ───────────────────────────────────────────────────────

export function instanceListPage(
  basePath: string,
  machineId: string,
  instances: DurableMachineStatus[],
  statusFilter?: string,
  restBasePath?: string,
): string {
  const filters = ["all", "PENDING", "SUCCESS", "ERROR", "CANCELLED"];

  const filterHtml = `<div class="filters">
    ${filters
      .map((f) => {
        const isActive =
          (f === "all" && !statusFilter) || f === statusFilter;
        const href =
          f === "all"
            ? `${basePath}/${machineId}`
            : `${basePath}/${machineId}?status=${f}`;
        return `<a class="filter-btn${isActive ? " active" : ""}" href="${esc(href)}">${esc(f)}</a>`;
      })
      .join("")}
  </div>`;

  let rows = "";
  if (instances.length === 0) {
    rows = `<tr><td colspan="2" class="empty">No instances</td></tr>`;
  } else {
    for (const inst of instances) {
      rows += `<tr>
        <td class="mono"><a href="${esc(basePath)}/${esc(machineId)}/${esc(inst.workflowId)}">${esc(inst.workflowId)}</a></td>
        <td>${statusBadge(inst.status)}</td>
      </tr>`;
    }
  }

  const sseUrl = `${basePath}/sse/${machineId}`;
  const startUrl = `${restBasePath ?? ""}/machines/${machineId}/instances`;

  const body = `
    <script type="application/json" id="base-path">${esc(basePath)}</script>
    <script type="application/json" id="machine-id">${esc(machineId)}</script>
    <div class="card start-instance-card">
      <h2>Start Instance</h2>
      <form id="start-form" class="start-form" data-url="${esc(startUrl)}" data-detail-base="${esc(basePath)}/${esc(machineId)}">
        <input type="text" name="instanceId" placeholder="Instance ID (required)" required />
        <textarea name="input" placeholder='{"key": "value"} (optional initial context)'></textarea>
        <div class="start-form-row">
          <button type="submit">Start</button>
          <span class="form-status" id="start-status"></span>
        </div>
      </form>
    </div>
    <div class="card">
      <h2>Instances: ${esc(machineId)}</h2>
      ${filterHtml}
      <table>
        <thead><tr><th>Instance ID</th><th>Status</th></tr></thead>
        <tbody id="instance-tbody">${rows}</tbody>
      </table>
    </div>`;

  return layout(
    {
      title: `${machineId} - Dashboard`,
      basePath,
      breadcrumbs: [{ label: machineId }],
      sseUrl,
    },
    body,
  );
}

// ── Instance Detail Page ─────────────────────────────────────────────────────

export interface InstanceDetailData {
  machineId: string;
  instanceId: string;
  snapshot: DurableStateSnapshot;
  steps: StepInfo[];
  graphData: GraphData;
  transitions: TransitionRecord[];
  stateDurations: StateDuration[];
  availableEvents: string[];
  effects?: EffectStatus[];
  eventLog?: EventLogEntry[];
  activeStates: string[];
  visitedStates: string[];
  activeSleep?: { stateId: string; delay: number; enteredAt: number; wakeAt: number } | null;
}

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
    effects,
    eventLog,
    activeStates,
    visitedStates,
    activeSleep,
  } = data;

  const sseUrl = `${basePath}/sse/${machineId}/${instanceId}`;
  const sendUrl = `${restBasePath}/machines/${machineId}/instances/${instanceId}/events`;

  // Graph panel
  const graphPanel = `
    <div class="card graph-panel">
      <h2>State Graph</h2>
      <div id="graph-container"></div>
      <script type="application/json" id="graph-data">${JSON.stringify(graphData)}</script>
      <script type="application/json" id="runtime-data">${JSON.stringify({ activeStates, visitedStates, activeSleep: activeSleep ?? null })}</script>
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
        <select name="eventType">
          <option value="">-- select event --</option>
          ${eventOptions}
        </select>
        <textarea name="payload" placeholder='{"key": "value"} (optional)'></textarea>
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

  // Error panel — shown when instance has errors
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
        { label: machineId, href: `${basePath}/${machineId}` },
        { label: instanceId },
      ],
      sseUrl,
    },
    body,
  );
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

  // Instance-level error status
  if (snapshot.status === "error") {
    // Check context for common error fields
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

  // Failed steps
  for (const s of steps) {
    if (s.error != null) {
      errors.push({
        source: `Step: ${s.name}`,
        message: typeof s.error === "string" ? s.error : JSON.stringify(s.error, null, 2),
      });
    }
  }

  // Failed effects
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
