import type {
  DurableMachineStatus,
  FormField,
  SerializedMachine,
} from "@durable-xstate/durable-machine";
import { CSS } from "./styles.js";
import { CLIENT_JS } from "./client.js";
import type { LayoutOptions, MachineListItem } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

export function esc(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function statusBadge(status: string): string {
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
