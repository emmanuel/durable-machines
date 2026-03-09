import type {
  DurableMachineStatus,
  DurableStateSnapshot,
  StepInfo,
  EffectStatus,
  EventLogEntry,
  TransitionRecord,
  StateDuration,
  FormField,
  SerializedMachine,
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

/**
 * Render FormField[] as HTML form inputs. Each input uses `data-field="name"`
 * and is named `${prefix}${name}` for collection by client JS.
 * Supports placeholder, helpText, defaultValue, and group-based fieldsets.
 */
function renderFormFields(fields: FormField[], prefix = ""): string {
  // Group fields: ungrouped first, then grouped by group name
  const grouped = new Map<string | undefined, FormField[]>();
  for (const f of fields) {
    const key = f.group;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(f);
  }

  let html = "";
  for (const [group, groupFields] of grouped) {
    const inner = groupFields.map((f) => renderSingleField(f, prefix)).join("\n");
    if (group) {
      html += `<fieldset class="field-group"><legend>${esc(group)}</legend>${inner}</fieldset>`;
    } else {
      html += inner;
    }
  }
  return html;
}

function renderSingleField(f: FormField, prefix: string): string {
  const inputName = `${prefix}${f.name}`;
  const req = f.required ? " required" : "";
  const placeholder = f.placeholder ?? f.label;
  const helpId = f.helpText ? `help-${esc(inputName)}` : "";
  const ariaDescribed = helpId ? ` aria-describedby="${helpId}"` : "";
  const helpHtml = f.helpText ? `<small class="help-text" id="${helpId}">${esc(f.helpText)}</small>` : "";
  const label = `<label for="${esc(inputName)}">${esc(f.label)}</label>`;

  let fieldHtml: string;
  switch (f.type) {
    case "select": {
      const options = (f.options ?? []).map((o) => {
        const sel = f.defaultValue === o ? " selected" : "";
        return `<option value="${esc(o)}"${sel}>${esc(o)}</option>`;
      }).join("");
      fieldHtml = `${label}<select name="${esc(inputName)}" id="${esc(inputName)}" data-field="${esc(f.name)}"${req}${ariaDescribed}>
            <option value="">-- select --</option>
            ${options}
          </select>`;
      break;
    }
    case "checkbox": {
      const checked = f.defaultValue === "true" ? " checked" : "";
      fieldHtml = `<label class="checkbox-label"><input type="checkbox" name="${esc(inputName)}" data-field="${esc(f.name)}" value="true"${checked}${ariaDescribed} /> ${esc(f.label)}</label>`;
      break;
    }
    case "number": {
      const val = f.defaultValue != null ? ` value="${esc(f.defaultValue)}"` : "";
      fieldHtml = `${label}<input type="number" name="${esc(inputName)}" id="${esc(inputName)}" data-field="${esc(f.name)}" placeholder="${esc(placeholder)}"${val}${req}${ariaDescribed} />`;
      break;
    }
    case "date": {
      const val = f.defaultValue != null ? ` value="${esc(f.defaultValue)}"` : "";
      fieldHtml = `${label}<input type="date" name="${esc(inputName)}" id="${esc(inputName)}" data-field="${esc(f.name)}"${val}${req}${ariaDescribed} />`;
      break;
    }
    default: {
      const val = f.defaultValue != null ? ` value="${esc(f.defaultValue)}"` : "";
      fieldHtml = `${label}<input type="text" name="${esc(inputName)}" id="${esc(inputName)}" data-field="${esc(f.name)}" placeholder="${esc(placeholder)}"${val}${req}${ariaDescribed} />`;
      break;
    }
  }
  return fieldHtml + helpHtml;
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

export interface MachineListItem {
  machineId: string;
  instanceCount: number;
  label?: string;
  description?: string;
  tags?: string[];
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
      const displayName = m.label
        ? `<span class="machine-label">${esc(m.label)}</span><br/><span class="mono" style="font-size:11px">${esc(m.machineId)}</span>`
        : `<span class="mono">${esc(m.machineId)}</span>`;
      const desc = m.description ? `<div class="machine-desc">${esc(m.description)}</div>` : "";
      const tags = m.tags && m.tags.length > 0
        ? `<div class="machine-tags">${m.tags.map((t) => `<span class="machine-tag">${esc(t)}</span>`).join("")}</div>`
        : "";
      rows += `<tr>
        <td><a href="${esc(basePath)}/machines/${esc(m.machineId)}">${displayName}</a>${desc}${tags}</td>
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
): string {
  const filters = ["all", "PENDING", "SUCCESS", "ERROR", "CANCELLED"];

  const filterHtml = `<div class="filters">
    ${filters
      .map((f) => {
        const isActive =
          (f === "all" && !statusFilter) || f === statusFilter;
        const href =
          f === "all"
            ? `${basePath}/machines/${machineId}`
            : `${basePath}/machines/${machineId}?status=${f}`;
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
        <td class="mono"><a href="${esc(basePath)}/machines/${esc(machineId)}/instances/${esc(inst.workflowId)}">${esc(inst.workflowId)}</a></td>
        <td>${statusBadge(inst.status)}</td>
      </tr>`;
    }
  }

  const sseUrl = `${basePath}/machines/${machineId}/stream`;
  const startUrl = `${basePath}/machines/${machineId}/new`;

  const body = `
    <script type="application/json" id="base-path">${esc(basePath)}</script>
    <script type="application/json" id="machine-id">${esc(machineId)}</script>
    <div style="margin-bottom:16px">
      <a href="${esc(startUrl)}" class="btn-start">Start New Instance</a>
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

// ── Start Instance Page ──────────────────────────────────────────────────────

export function startInstancePage(
  basePath: string,
  machineId: string,
  definition: SerializedMachine,
  restBasePath: string,
): string {
  const label = definition.label ?? machineId;
  const description = definition.description;
  const inputSchema = definition.inputSchema;
  const startUrl = `${restBasePath}/machines/${machineId}/instances`;

  const descHtml = description
    ? `<p class="machine-description">${esc(description)}</p>`
    : "";

  const fieldsHtml = inputSchema && inputSchema.length > 0
    ? renderFormFields(inputSchema, "input-")
    : '<textarea name="input" placeholder=\'{"key": "value"} (optional initial context)\'></textarea>';

  const body = `
    <div class="card start-page-card">
      <h2>Start New Instance: ${esc(label)}</h2>
      ${descHtml}
      <form id="start-form" class="start-form" data-url="${esc(startUrl)}" data-detail-base="${esc(basePath)}/machines/${esc(machineId)}/instances"${inputSchema && inputSchema.length > 0 ? ' data-has-schema="true"' : ""}>
        <input type="text" name="instanceId" placeholder="Instance ID (required)" required />
        ${fieldsHtml}
        <div class="start-form-row">
          <button type="submit">Start</button>
          <a href="${esc(basePath)}/machines/${esc(machineId)}" class="btn-cancel">Cancel</a>
          <span class="form-status" id="start-status"></span>
        </div>
      </form>
    </div>`;

  return layout(
    {
      title: `Start ${label} - Dashboard`,
      basePath,
      breadcrumbs: [
        { label: machineId, href: `${basePath}/machines/${machineId}` },
        { label: "New" },
      ],
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
  eventSchemas?: Record<string, FormField[]>;
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
        { label: machineId, href: `${basePath}/machines/${machineId}` },
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
