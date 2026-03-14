/**
 * Dark-themed CSS for the dashboard. Uses CSS custom properties for theming.
 */
export const CSS = /* css */ `
:root {
  --bg: #0f1117;
  --bg-card: #1a1d27;
  --bg-hover: #22263a;
  --bg-input: #13151e;
  --border: #2a2e3e;
  --border-active: #4f6ef7;
  --text: #e1e4ed;
  --text-dim: #8b8fa3;
  --text-bright: #ffffff;
  --accent: #4f6ef7;
  --accent-dim: #3a54c0;
  --green: #34d399;
  --yellow: #fbbf24;
  --red: #f87171;
  --orange: #fb923c;
  --purple: #a78bfa;
  --font-mono: "SF Mono", "Cascadia Code", "Fira Code", Consolas, monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --radius: 8px;
  --radius-sm: 4px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  min-height: 100vh;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

/* ── Layout ─────────────────────────────────────── */

.container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 24px;
}

header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-card);
}

header h1 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-bright);
}

header h1 span { color: var(--accent); }

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-dim);
}

.breadcrumb a { color: var(--text-dim); }
.breadcrumb a:hover { color: var(--accent); }
.breadcrumb .sep { color: var(--border); }

/* ── Cards & Tables ─────────────────────────────── */

.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  margin-bottom: 16px;
}

.card h2 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 16px;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

th {
  text-align: left;
  color: var(--text-dim);
  font-weight: 500;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

tr:hover td { background: var(--bg-hover); }
tr:last-child td { border-bottom: none; }

.mono { font-family: var(--font-mono); font-size: 13px; }

/* ── Status Badges ──────────────────────────────── */

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.badge-running { background: rgba(79,110,247,0.15); color: var(--accent); }
.badge-done, .badge-success { background: rgba(52,211,153,0.15); color: var(--green); }
.badge-error { background: rgba(248,113,113,0.15); color: var(--red); }
.badge-pending { background: rgba(251,191,36,0.15); color: var(--yellow); }
.badge-cancelled { background: rgba(139,143,163,0.15); color: var(--text-dim); }

/* ── Instance Detail Grid ───────────────────────── */

.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: auto auto;
  gap: 16px;
}

@media (max-width: 900px) {
  .detail-grid { grid-template-columns: 1fr; }
}

.detail-grid .graph-panel { grid-row: 1; grid-column: 1; }
.detail-grid .timeline-panel { grid-row: 1; grid-column: 2; }
.detail-grid .context-panel { grid-row: 2; grid-column: 1; }
.detail-grid .event-panel { grid-row: 2; grid-column: 2; }

@media (max-width: 900px) {
  .detail-grid .graph-panel,
  .detail-grid .timeline-panel,
  .detail-grid .context-panel,
  .detail-grid .event-panel {
    grid-row: auto;
    grid-column: 1;
  }
}

/* ── Graph ──────────────────────────────────────── */

#graph-container {
  min-height: 200px;
  overflow: auto;
  position: relative;
}

#graph-container svg {
  display: block;
}

.graph-node rect {
  fill: var(--bg);
  stroke: var(--border);
  stroke-width: 1.5;
  rx: 6;
}

.graph-node.durable rect {
  stroke-width: 2.5;
  stroke: var(--accent);
}

.graph-node.active rect {
  stroke: var(--accent);
  stroke-width: 2.5;
  animation: pulse 2s ease-in-out infinite;
}

.graph-node.visited rect {
  stroke: var(--accent-dim);
  stroke-width: 1.5;
  opacity: 0.7;
}

.graph-node.final rect {
  stroke-width: 2.5;
  stroke: var(--green);
}

.graph-node.final.active rect {
  stroke: var(--accent);
  animation: pulse 2s ease-in-out infinite;
}

.graph-node text {
  fill: var(--text);
  font-size: 12px;
  font-family: var(--font-sans);
}

.graph-node .icon {
  fill: var(--text-dim);
  font-size: 10px;
}

.graph-edge path {
  fill: none;
  stroke: var(--border);
  stroke-width: 1.5;
}

.graph-edge.active path {
  stroke: var(--accent);
  stroke-width: 2;
}

.graph-edge polygon {
  fill: var(--border);
}

.graph-edge.active polygon {
  fill: var(--accent);
}

.graph-edge text {
  fill: var(--text-dim);
  font-size: 10px;
  font-family: var(--font-sans);
}

.graph-compound rect {
  fill: var(--bg-card);
  stroke: var(--border);
  stroke-width: 1;
  stroke-dasharray: 4 2;
  rx: 8;
}

@keyframes pulse {
  0%, 100% { filter: drop-shadow(0 0 4px rgba(79,110,247,0.3)); }
  50% { filter: drop-shadow(0 0 12px rgba(79,110,247,0.6)); }
}

/* ── Activity Feed ──────────────────────────────── */

.activity-feed { max-height: 500px; overflow-y: auto; }
.af-entry { border-bottom: 1px solid var(--border); }
.af-entry[open] { background: rgba(79,110,247,0.03); }
.af-entry summary { list-style: none; cursor: pointer; }
.af-entry summary::-webkit-details-marker { display: none; }
.af-row { display: flex; gap: 5px; align-items: center; padding: 5px 8px; font-size: 12px; font-family: var(--font-mono); color: var(--text-dim); border-bottom: 1px solid var(--border); }
.af-entry > .af-row { border-bottom: none; }
.af-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.af-dot-transition { background: var(--accent); }
.af-dot-self { background: var(--yellow); }
.af-dot-event { background: var(--purple); opacity: 0.55; }
.af-state { color: var(--text); font-weight: 600; }
.af-self { color: var(--yellow); }
.af-tag { font-size: 9px; padding: 0 4px; border-radius: 3px; }
.af-tag-event { background: rgba(167,139,250,0.15); color: var(--purple); }
.af-tag-step { background: rgba(52,211,153,0.15); color: var(--green); }
.af-tag-done { background: rgba(52,211,153,0.2); color: var(--green); }
.af-tag-error { background: rgba(248,113,113,0.2); color: var(--red); }
.af-tag-self { background: rgba(251,191,36,0.15); color: var(--yellow); }
.af-tag-guard { background: rgba(139,143,163,0.15); color: var(--text-dim); font-style: italic; }
.af-tag-effect { background: rgba(90,170,255,0.15); color: var(--cyan,#5af); }
.af-tag-ignored { background: rgba(139,143,163,0.15); color: var(--text-dim); }
.af-ts { margin-left: auto; font-size: 10px; flex-shrink: 0; }
.af-unmatched { opacity: 0.55; }
.af-detail { border-left: 2px solid var(--accent); margin: 0 8px 4px 16px; padding: 5px 8px; border-radius: 0 4px 4px 0; font-size: 11px; font-family: var(--font-mono); background: rgba(79,110,247,0.03); }
.af-detail-line { display: flex; gap: 6px; padding: 1px 0; }
.af-detail-label { color: var(--text-dim); width: 55px; flex-shrink: 0; }
.af-detail-val { color: var(--text); }
.af-detail-section { margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(79,110,247,0.1); }
.af-section-head { font-size: 10px; margin-bottom: 2px; }
.af-json { color: var(--text); background: var(--bg); padding: 3px 6px; border-radius: 3px; font-size: 10px; white-space: pre-wrap; word-break: break-all; }
.af-duration { color: var(--yellow); }
.af-error-box { background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.2); border-radius: 4px; padding: 4px 6px; margin-top: 3px; color: var(--red); font-size: 10px; white-space: pre-wrap; }
.af-diff { font-size: 10px; color: var(--text); background: var(--bg); padding: 2px 6px; border-radius: 3px; margin-top: 2px; }
.af-diff-before { color: var(--text-dim); }
.af-diff-after { color: var(--green); }
.af-event-type { color: var(--purple); }

/* ── Duration (used by effects panel) ─────────── */

.timeline-duration {
  color: var(--text-dim);
  font-size: 11px;
}

/* ── Context Inspector ──────────────────────────── */

.json-tree {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
}

.json-tree details { margin-left: 16px; }
.json-tree summary {
  cursor: pointer;
  color: var(--text);
  list-style: none;
}
.json-tree summary::before {
  content: "\\25b6 ";
  font-size: 10px;
  color: var(--text-dim);
}
.json-tree details[open] > summary::before { content: "\\25bc "; }

.json-key { color: var(--accent); }
.json-string { color: var(--green); }
.json-number { color: var(--orange); }
.json-boolean { color: var(--yellow); }
.json-null { color: var(--text-dim); }

/* ── Event Sender ───────────────────────────────── */

.event-form { display: flex; flex-direction: column; gap: 12px; }

.event-form select,
.event-form textarea,
.event-form button {
  font-family: var(--font-mono);
  font-size: 13px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text);
  padding: 8px 12px;
}

.event-form select:focus,
.event-form textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.event-form textarea {
  min-height: 80px;
  resize: vertical;
}

.event-form button {
  background: var(--accent);
  color: var(--text-bright);
  border: none;
  cursor: pointer;
  font-weight: 600;
  padding: 10px 16px;
}

.event-form button:hover { background: var(--accent-dim); }

.event-form .form-status {
  font-size: 12px;
  min-height: 18px;
}

.event-form .form-status.error { color: var(--red); }
.event-form .form-status.success { color: var(--green); }

/* ── Effects Panel ──────────────────────────────── */

.effect-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.effect-row:last-child { border-bottom: none; }

.effect-type {
  font-family: var(--font-mono);
  color: var(--purple);
}

/* ── Filters ────────────────────────────────────── */

.filters {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.filter-btn {
  padding: 4px 12px;
  border-radius: 14px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}

.filter-btn:hover { border-color: var(--accent); color: var(--text); }
.filter-btn.active { background: var(--accent); color: var(--text-bright); border-color: var(--accent); }

/* ── Empty State ────────────────────────────────── */

.empty {
  text-align: center;
  padding: 40px;
  color: var(--text-dim);
  font-size: 14px;
}

/* ── SSE Connection Indicator ───────────────────── */

.sse-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  margin-left: 8px;
}

.sse-indicator.connected { background: var(--green); }
.sse-indicator.disconnected { background: var(--red); }
.sse-indicator.connecting { background: var(--yellow); animation: pulse 1s infinite; }

/* ── Error Panel ────────────────────────────────── */

.error-panel {
  background: rgba(248,113,113,0.08);
  border: 1px solid rgba(248,113,113,0.3);
  border-radius: var(--radius);
  padding: 16px 20px;
  margin-bottom: 16px;
}

.error-panel h2 {
  font-size: 14px;
  font-weight: 600;
  color: var(--red);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}

.error-item {
  padding: 8px 0;
  border-bottom: 1px solid rgba(248,113,113,0.15);
  font-size: 13px;
}

.error-item:last-child { border-bottom: none; }

.error-item-source {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 4px;
}

.error-item-message {
  color: var(--red);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── Start Instance Form ───────────────────────── */

.start-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.start-form input,
.start-form textarea {
  font-family: var(--font-mono);
  font-size: 13px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text);
  padding: 8px 12px;
}

.start-form input:focus,
.start-form textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.start-form textarea {
  min-height: 60px;
  resize: vertical;
}

.start-form button {
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 600;
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  border: none;
  background: var(--green);
  color: var(--bg);
  cursor: pointer;
}

.start-form button:hover { opacity: 0.9; }

.start-form-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* ── Danger Button ─────────────────────────────── */

.btn-danger {
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--red);
  background: transparent;
  color: var(--red);
  cursor: pointer;
}

.btn-danger:hover:not(:disabled) {
  background: rgba(248,113,113,0.15);
}

.btn-danger:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ── Sleep Countdown ───────────────────────────── */

.sleep-countdown {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--yellow);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: rgba(251,191,36,0.1);
  display: inline-block;
  margin-top: 4px;
}

.sleep-countdown.firing {
  color: var(--orange);
  background: rgba(251,146,60,0.15);
  animation: pulse 0.5s ease-in-out infinite;
}

/* SVG countdown text (inside graph) */
svg .sleep-countdown {
  fill: var(--yellow);
  font-size: 10px;
  font-family: var(--font-mono);
  font-weight: 600;
}

svg .sleep-countdown.firing {
  fill: var(--orange);
}

/* ── Analytics (SVG graph) ────────────────────── */

svg .analytics-duration {
  fill: var(--text-dim);
  font-size: 9px;
  font-family: var(--font-mono);
  font-weight: 500;
}

/* Heat map: tint node rect fill based on relative dwell time */
.graph-node.analytics-cool rect {
  fill: rgba(52, 211, 153, 0.06);
}

.graph-node.analytics-warm rect {
  fill: rgba(251, 191, 36, 0.08);
}

.graph-node.analytics-hot rect {
  fill: rgba(248, 113, 113, 0.10);
}

/* Don't override active/visited stroke colors */
.graph-node.active.analytics-cool rect,
.graph-node.active.analytics-warm rect,
.graph-node.active.analytics-hot rect {
  stroke: var(--accent);
}

/* ── Schema Form Fields ───────────────────────── */

.event-form label,
.start-form label {
  font-size: 12px;
  color: var(--text-dim);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.event-form .checkbox-label,
.start-form .checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  text-transform: none;
  letter-spacing: 0;
  color: var(--text);
  cursor: pointer;
}

.event-form input[type="checkbox"],
.start-form input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

#event-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

#event-fields input,
#event-fields select {
  font-family: var(--font-mono);
  font-size: 13px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text);
  padding: 8px 12px;
}

#event-fields input:focus,
#event-fields select:focus {
  outline: none;
  border-color: var(--accent);
}

/* ── Start Button (instance list) ───────────────── */

.btn-start {
  display: inline-block;
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  background: var(--green);
  color: var(--bg);
  font-weight: 600;
  font-size: 13px;
  text-decoration: none;
}

.btn-start:hover { opacity: 0.9; text-decoration: none; }

/* ── Cancel Button (start page) ─────────────────── */

.btn-cancel {
  display: inline-block;
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  text-decoration: none;
}

.btn-cancel:hover { border-color: var(--text-dim); color: var(--text); text-decoration: none; }

/* ── Start Page ─────────────────────────────────── */

.start-page-card { max-width: 600px; }

.machine-description {
  color: var(--text-dim);
  font-size: 14px;
  margin-bottom: 16px;
}

/* ── Help Text ──────────────────────────────────── */

.help-text {
  display: block;
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
  margin-bottom: 4px;
}

/* ── Field Groups ───────────────────────────────── */

.field-group {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px;
  margin-bottom: 8px;
}

.field-group legend {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 0 6px;
}

/* ── Machine Metadata (list page) ───────────────── */

.machine-label { font-weight: 600; color: var(--text-bright); }
.machine-desc { font-size: 12px; color: var(--text-dim); margin-top: 2px; }
.machine-tags { display: flex; gap: 4px; margin-top: 4px; }
.machine-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 10px;
  background: rgba(79,110,247,0.12);
  color: var(--accent);
}

.start-form select {
  font-family: var(--font-mono);
  font-size: 13px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text);
  padding: 8px 12px;
}

.start-form select:focus {
  outline: none;
  border-color: var(--accent);
}
`;
