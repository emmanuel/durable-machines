/**
 * Client-side JavaScript embedded inline in the dashboard HTML.
 * Handles ELK graph layout, SVG rendering, SSE live updates, and event sending.
 */
export const CLIENT_JS = /* js */ `
(function() {
  'use strict';

  // ── Graph Rendering ──────────────────────────────────────────

  const ELK_CDN = 'https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk.bundled.js';

  async function loadElk() {
    return new Promise((resolve, reject) => {
      if (window.ELK) return resolve(new window.ELK());
      const s = document.createElement('script');
      s.src = ELK_CDN;
      s.onload = () => resolve(new window.ELK());
      s.onerror = () => reject(new Error('Failed to load ELK'));
      document.head.appendChild(s);
    });
  }

  function toElkGraph(graphData, runtimeState) {
    // Analytics lookup maps (built once, reused for node heights and edge labels)
    var durationByState = {};
    var hasAnalytics = false;
    if (runtimeState && runtimeState.aggregateStateDurations) {
      hasAnalytics = true;
      for (var ai = 0; ai < runtimeState.aggregateStateDurations.length; ai++) {
        var ad = runtimeState.aggregateStateDurations[ai];
        var aKey = typeof ad.stateValue === 'string' ? ad.stateValue : JSON.stringify(ad.stateValue);
        durationByState[aKey] = ad;
      }
    }
    var countByEdge = {};
    var maxEdgeCount = 1;
    if (runtimeState && runtimeState.transitionCounts) {
      hasAnalytics = true;
      for (var ci = 0; ci < runtimeState.transitionCounts.length; ci++) {
        var tc = runtimeState.transitionCounts[ci];
        var fromKey = tc.fromState != null ? (typeof tc.fromState === 'string' ? tc.fromState : JSON.stringify(tc.fromState)) : '';
        var toKey = typeof tc.toState === 'string' ? tc.toState : JSON.stringify(tc.toState);
        countByEdge[fromKey + '->' + toKey] = tc.count;
        if (tc.count > maxEdgeCount) maxEdgeCount = tc.count;
      }
    }

    const nodeMap = new Map();
    for (const n of graphData.nodes) {
      nodeMap.set(n.id, {
        id: n.id,
        labels: [{ text: n.label }],
        width: Math.max(120, n.label.length * 9 + 40),
        height: hasAnalytics ? 56 : 40,
        layoutOptions: n.children.length > 0 ? {
          'elk.algorithm': 'layered',
          'elk.direction': 'DOWN',
          'elk.padding': '[top=35,left=15,bottom=15,right=15]',
        } : {},
        children: [],
        _meta: n,
        _analytics: durationByState[n.id] || null,
      });
    }

    // Build hierarchy
    const roots = [];
    for (const n of graphData.nodes) {
      const elkNode = nodeMap.get(n.id);
      if (n.parent && nodeMap.has(n.parent)) {
        nodeMap.get(n.parent).children.push(elkNode);
      } else {
        roots.push(elkNode);
      }
    }

    const edges = graphData.edges.map(function(e, i) {
      var edgeKey = (e.source || '') + '->' + (e.target || '');
      var cnt = countByEdge[edgeKey];
      var labelText = e.label || '';
      if (cnt != null) {
        labelText = labelText ? labelText + ' (' + cnt + '\u00d7)' : cnt + '\u00d7';
      }
      return {
        id: 'e' + i,
        sources: [e.source],
        targets: [e.target],
        labels: labelText ? [{ text: labelText }] : [],
        _meta: e,
        _count: cnt || 0,
        _countRatio: cnt ? cnt / maxEdgeCount : 0,
      };
    });

    return {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'DOWN',
        'elk.spacing.nodeNode': '30',
        'elk.spacing.edgeNode': '20',
        'elk.layered.spacing.nodeNodeBetweenLayers': '40',
      },
      children: roots,
      edges: edges,
    };
  }

  function renderSvg(layout, graphData, runtimeState) {
    const activeStates = runtimeState?.activeStates || [];
    const visitedStates = runtimeState?.visitedStates || [];
    const activeSleep = runtimeState?.activeSleep || null;

    // Analytics lookup for heat map computation
    var durationByState = {};
    if (runtimeState && runtimeState.aggregateStateDurations) {
      for (var di = 0; di < runtimeState.aggregateStateDurations.length; di++) {
        var dd = runtimeState.aggregateStateDurations[di];
        var dk = typeof dd.stateValue === 'string' ? dd.stateValue : JSON.stringify(dd.stateValue);
        durationByState[dk] = dd;
      }
    }

    const pad = 20;
    const w = (layout.width || 600) + pad * 2;
    const h = (layout.height || 400) + pad * 2;

    let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">';

    function renderNode(node, ox, oy) {
      const x = (node.x || 0) + ox + pad;
      const y = (node.y || 0) + oy + pad;
      const meta = node._meta;

      if (!meta) return '';

      let out = '';

      if (node.children && node.children.length > 0) {
        // Compound/parallel node
        out += '<g class="graph-compound">';
        out += '<rect x="' + x + '" y="' + y + '" width="' + (node.width || 120) + '" height="' + (node.height || 40) + '"/>';
        out += '<text x="' + (x + 8) + '" y="' + (y + 16) + '" font-size="11" fill="var(--text-dim)">' + esc(meta.label) + '</text>';
        for (const child of node.children) {
          out += renderNode(child, x, y);
        }
        out += '</g>';
      } else {
        // Leaf node
        const isActive = activeStates.includes(meta.id);
        const isVisited = visitedStates.includes(meta.id);
        let cls = 'graph-node';
        if (meta.durable) cls += ' durable';
        if (meta.type === 'final') cls += ' final';
        if (isActive) cls += ' active';
        else if (isVisited) cls += ' visited';

        // Analytics heat mapping
        if (node._analytics) {
          var maxAvg = 0;
          for (var hk in durationByState) {
            if (durationByState[hk].avgMs > maxAvg) maxAvg = durationByState[hk].avgMs;
          }
          var ratio = maxAvg > 0 ? node._analytics.avgMs / maxAvg : 0;
          cls += ratio > 0.66 ? ' analytics-hot' : ratio > 0.33 ? ' analytics-warm' : ' analytics-cool';
        }

        out += '<g class="' + cls + '">';
        out += '<rect x="' + x + '" y="' + y + '" width="' + (node.width || 120) + '" height="' + (node.height || 40) + '"/>';

        // Label — shift up when analytics sublabel present
        let labelX = x + (node.width || 120) / 2;
        const labelY = node._analytics ? y + (node.height || 40) / 2 - 2 : y + (node.height || 40) / 2 + 4;
        out += '<text x="' + labelX + '" y="' + labelY + '" text-anchor="middle">' + esc(meta.label) + '</text>';

        // Analytics: dwell-time sublabel inside node
        if (node._analytics) {
          out += '<text class="analytics-duration" x="' + labelX + '" y="' + (labelY + 14) + '" text-anchor="middle">avg ' + formatDuration(node._analytics.avgMs) + '</text>';
        }

        // Icons
        let iconX = x + (node.width || 120) - 14;
        const iconY = y + 12;
        if (meta.durable) {
          out += '<text class="icon" x="' + iconX + '" y="' + iconY + '">&#x1f6e1;</text>';
          iconX -= 14;
        }
        if (meta.hasPrompt) {
          out += '<text class="icon" x="' + iconX + '" y="' + iconY + '">&#x1f4ac;</text>';
          iconX -= 14;
        }
        if (meta.hasInvoke) {
          out += '<text class="icon" x="' + iconX + '" y="' + iconY + '">&#x2699;</text>';
        }

        out += '</g>';
      }

      return out;
    }

    // Render nodes
    if (layout.children) {
      for (const child of layout.children) {
        svg += renderNode(child, 0, 0);
      }
    }

    // Render edges
    if (layout.edges) {
      for (const edge of layout.edges) {
        const meta = edge._meta;
        const isActive = meta && activeStates.includes(meta.source);
        const cls = 'graph-edge' + (isActive ? ' active' : '');
        svg += '<g class="' + cls + '">';

        // Scale edge stroke-width by relative frequency
        var edgeStroke = '';
        if (edge._countRatio > 0) {
          var sw = 1.5 + edge._countRatio * 3;
          edgeStroke = ' style="stroke-width:' + sw.toFixed(1) + '"';
        }

        if (edge.sections) {
          for (const section of edge.sections) {
            let d = 'M' + (section.startPoint.x + pad) + ',' + (section.startPoint.y + pad);
            if (section.bendPoints) {
              for (const bp of section.bendPoints) {
                d += ' L' + (bp.x + pad) + ',' + (bp.y + pad);
              }
            }
            d += ' L' + (section.endPoint.x + pad) + ',' + (section.endPoint.y + pad);
            svg += '<path d="' + d + '"' + edgeStroke + ' marker-end="url(#arrow)"/>';
          }
        }

        // Edge label
        if (edge.labels && edge.labels[0] && edge.labels[0].x != null) {
          const lbl = edge.labels[0];
          svg += '<text x="' + (lbl.x + pad) + '" y="' + (lbl.y + pad - 2) + '">' + esc(lbl.text) + '</text>';

          // Add countdown badge for active after-edges
          if (meta && meta.type === 'after' && activeSleep && activeSleep.stateId === meta.source) {
            var remaining = activeSleep.wakeAt - Date.now();
            var countdownText = remaining > 0 ? formatDuration(remaining) : 'firing...';
            svg += '<text class="sleep-countdown" data-wake-at="' + activeSleep.wakeAt + '" x="' + (lbl.x + pad) + '" y="' + (lbl.y + pad + 12) + '">' + esc(countdownText) + '</text>';
          }
        }

        svg += '</g>';
      }
    }

    // Arrow marker definition
    svg += '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">';
    svg += '<polygon points="0,0 10,5 0,10"/>';
    svg += '</marker></defs>';

    svg += '</svg>';
    return svg;
  }

  // ── Fallback Layout (no CDN) ───────────────────────────────

  function fallbackLayout(graphData, runtimeState) {
    const activeStates = runtimeState?.activeStates || [];
    const visitedStates = runtimeState?.visitedStates || [];
    const activeSleep = runtimeState?.activeSleep || null;
    const leaves = graphData.nodes.filter(n => n.children.length === 0);
    const nodeW = 140;
    const gapX = 30;
    const gapY = 60;
    const pad = 30;

    // Analytics lookup maps
    var fbDurationByState = {};
    var fbHasAnalytics = false;
    if (runtimeState && runtimeState.aggregateStateDurations) {
      fbHasAnalytics = true;
      for (var fai = 0; fai < runtimeState.aggregateStateDurations.length; fai++) {
        var fad = runtimeState.aggregateStateDurations[fai];
        var faKey = typeof fad.stateValue === 'string' ? fad.stateValue : JSON.stringify(fad.stateValue);
        fbDurationByState[faKey] = fad;
      }
    }
    var fbCountByEdge = {};
    var fbMaxEdgeCount = 1;
    if (runtimeState && runtimeState.transitionCounts) {
      fbHasAnalytics = true;
      for (var fci = 0; fci < runtimeState.transitionCounts.length; fci++) {
        var ftc = runtimeState.transitionCounts[fci];
        var ffk = ftc.fromState != null ? (typeof ftc.fromState === 'string' ? ftc.fromState : JSON.stringify(ftc.fromState)) : '';
        var ftk = typeof ftc.toState === 'string' ? ftc.toState : JSON.stringify(ftc.toState);
        fbCountByEdge[ffk + '->' + ftk] = ftc.count;
        if (ftc.count > fbMaxEdgeCount) fbMaxEdgeCount = ftc.count;
      }
    }

    var nodeH = fbHasAnalytics ? 56 : 40;

    // Assign depth by BFS from initial
    const depth = new Map();
    const targetOf = new Map();
    for (const e of graphData.edges) {
      if (!targetOf.has(e.source)) targetOf.set(e.source, []);
      targetOf.get(e.source).push(e.target);
    }

    const queue = [graphData.initial];
    depth.set(graphData.initial, 0);
    while (queue.length > 0) {
      const cur = queue.shift();
      const targets = targetOf.get(cur) || [];
      for (const t of targets) {
        if (!depth.has(t)) {
          depth.set(t, depth.get(cur) + 1);
          queue.push(t);
        }
      }
    }

    // Assign depth to unvisited nodes
    for (const n of leaves) {
      if (!depth.has(n.id)) depth.set(n.id, 999);
    }

    // Group by depth
    const rows = new Map();
    for (const n of leaves) {
      const d = depth.get(n.id);
      if (!rows.has(d)) rows.set(d, []);
      rows.get(d).push(n);
    }

    const positions = new Map();
    const sortedDepths = [...rows.keys()].sort((a, b) => a - b);
    let maxRowWidth = 0;

    for (const d of sortedDepths) {
      const row = rows.get(d);
      maxRowWidth = Math.max(maxRowWidth, row.length);
    }

    for (let di = 0; di < sortedDepths.length; di++) {
      const d = sortedDepths[di];
      const row = rows.get(d);
      const totalWidth = row.length * nodeW + (row.length - 1) * gapX;
      const startX = (maxRowWidth * (nodeW + gapX) - gapX - totalWidth) / 2;

      for (let i = 0; i < row.length; i++) {
        positions.set(row[i].id, {
          x: pad + startX + i * (nodeW + gapX),
          y: pad + di * (nodeH + gapY),
        });
      }
    }

    const w = maxRowWidth * (nodeW + gapX) - gapX + pad * 2;
    const h = sortedDepths.length * (nodeH + gapY) - gapY + pad * 2;

    let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">';

    // Draw edges as straight lines
    for (const e of graphData.edges) {
      const from = positions.get(e.source);
      const to = positions.get(e.target);
      if (!from || !to) continue;
      const isActive = activeStates.includes(e.source);
      const cls = 'graph-edge' + (isActive ? ' active' : '');

      // Edge stroke-width scaling
      var fbEdgeKey = (e.source || '') + '->' + (e.target || '');
      var fbEdgeCount = fbCountByEdge[fbEdgeKey];
      var fbEdgeStroke = '';
      if (fbEdgeCount > 0) {
        var fbSw = 1.5 + (fbEdgeCount / fbMaxEdgeCount) * 3;
        fbEdgeStroke = ' style="stroke-width:' + fbSw.toFixed(1) + '"';
      }

      // Build label with optional count
      var fbLabelText = e.label || '';
      if (fbEdgeCount != null) {
        fbLabelText = fbLabelText ? fbLabelText + ' (' + fbEdgeCount + '\u00d7)' : fbEdgeCount + '\u00d7';
      }

      svg += '<g class="' + cls + '">';
      svg += '<path d="M' + (from.x + nodeW / 2) + ',' + (from.y + nodeH) + ' L' + (to.x + nodeW / 2) + ',' + to.y + '"' + fbEdgeStroke + ' marker-end="url(#arrow)"/>';
      if (fbLabelText) {
        const mx = (from.x + to.x + nodeW) / 2;
        const my = (from.y + nodeH + to.y) / 2 - 4;
        svg += '<text x="' + mx + '" y="' + my + '" text-anchor="middle">' + esc(fbLabelText) + '</text>';
        // Add countdown for active after-edges
        if (e.type === 'after' && activeSleep && activeSleep.stateId === e.source) {
          var remaining = activeSleep.wakeAt - Date.now();
          var countdownText = remaining > 0 ? formatDuration(remaining) : 'firing...';
          svg += '<text class="sleep-countdown" data-wake-at="' + activeSleep.wakeAt + '" x="' + mx + '" y="' + (my + 14) + '" text-anchor="middle">' + esc(countdownText) + '</text>';
        }
      }
      svg += '</g>';
    }

    // Draw nodes
    for (const n of leaves) {
      const pos = positions.get(n.id);
      if (!pos) continue;
      const isActive = activeStates.includes(n.id);
      const isVisited = visitedStates.includes(n.id);
      let cls = 'graph-node';
      if (n.durable) cls += ' durable';
      if (n.type === 'final') cls += ' final';
      if (isActive) cls += ' active';
      else if (isVisited) cls += ' visited';

      // Analytics heat mapping
      var fbNodeDur = fbDurationByState[n.id];
      if (fbNodeDur) {
        var fbMaxAvg = 0;
        for (var fbhk in fbDurationByState) {
          if (fbDurationByState[fbhk].avgMs > fbMaxAvg) fbMaxAvg = fbDurationByState[fbhk].avgMs;
        }
        var fbRatio = fbMaxAvg > 0 ? fbNodeDur.avgMs / fbMaxAvg : 0;
        cls += fbRatio > 0.66 ? ' analytics-hot' : fbRatio > 0.33 ? ' analytics-warm' : ' analytics-cool';
      }

      svg += '<g class="' + cls + '">';
      svg += '<rect x="' + pos.x + '" y="' + pos.y + '" width="' + nodeW + '" height="' + nodeH + '"/>';

      var fbLabelY = fbNodeDur ? pos.y + nodeH / 2 - 2 : pos.y + nodeH / 2 + 4;
      svg += '<text x="' + (pos.x + nodeW / 2) + '" y="' + fbLabelY + '" text-anchor="middle">' + esc(n.label) + '</text>';

      // Analytics: dwell-time sublabel
      if (fbNodeDur) {
        svg += '<text class="analytics-duration" x="' + (pos.x + nodeW / 2) + '" y="' + (fbLabelY + 14) + '" text-anchor="middle">avg ' + formatDuration(fbNodeDur.avgMs) + '</text>';
      }

      svg += '</g>';
    }

    svg += '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">';
    svg += '<polygon points="0,0 10,5 0,10"/>';
    svg += '</marker></defs>';
    svg += '</svg>';
    return svg;
  }

  async function renderGraph(graphData, runtimeState) {
    const container = document.getElementById('graph-container');
    if (!container || !graphData) return;

    try {
      const elk = await loadElk();
      const elkGraph = toElkGraph(graphData, runtimeState);
      const layout = await elk.layout(elkGraph);
      container.innerHTML = renderSvg(layout, graphData, runtimeState);
    } catch (e) {
      console.warn('ELK layout failed, using fallback:', e);
      container.innerHTML = fallbackLayout(graphData, runtimeState);
    }
  }

  // ── Runtime State Extraction ───────────────────────────────

  function extractRuntimeState() {
    const el = document.getElementById('runtime-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch { return null; }
  }

  function extractGraphDataFromPage() {
    const el = document.getElementById('graph-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch { return null; }
  }

  // ── JSON Tree Rendering ────────────────────────────────────

  function jsonTree(obj, depth) {
    if (depth === undefined) depth = 0;
    if (obj === null) return '<span class="json-null">null</span>';
    if (obj === undefined) return '<span class="json-null">undefined</span>';

    const t = typeof obj;
    if (t === 'string') return '<span class="json-string">"' + esc(obj) + '"</span>';
    if (t === 'number') return '<span class="json-number">' + obj + '</span>';
    if (t === 'boolean') return '<span class="json-boolean">' + obj + '</span>';

    if (Array.isArray(obj)) {
      if (obj.length === 0) return '<span class="json-null">[]</span>';
      let html = '<details' + (depth < 2 ? ' open' : '') + '><summary>[' + obj.length + ' items]</summary>';
      for (let i = 0; i < obj.length; i++) {
        html += '<div><span class="json-key">' + i + '</span>: ' + jsonTree(obj[i], depth + 1) + '</div>';
      }
      html += '</details>';
      return html;
    }

    if (t === 'object') {
      const keys = Object.keys(obj);
      if (keys.length === 0) return '<span class="json-null">{}</span>';
      let html = '<details' + (depth < 2 ? ' open' : '') + '><summary>{' + keys.length + ' keys}</summary>';
      for (const k of keys) {
        html += '<div><span class="json-key">' + esc(k) + '</span>: ' + jsonTree(obj[k], depth + 1) + '</div>';
      }
      html += '</details>';
      return html;
    }

    return esc(String(obj));
  }

  function updateContextPanel(context) {
    const el = document.getElementById('context-tree');
    if (el) el.innerHTML = jsonTree(context, 0);
  }

  // ── Timeline Rendering ─────────────────────────────────────

  function formatDuration(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'm';
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString();
  }

  function stateValueStr(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v !== null) {
      return Object.entries(v).map(function(e) { return e[0] + '.' + stateValueStr(e[1]); }).join(', ');
    }
    return String(v);
  }

  function renderTimeline(transitions, durations, activeSleep) {
    const el = document.getElementById('timeline-entries');
    if (!el) return;

    if (!transitions || transitions.length === 0) {
      el.innerHTML = '<div class="empty">No transitions yet</div>';
      return;
    }

    let html = '';
    // Show newest first
    for (let i = transitions.length - 1; i >= 0; i--) {
      const t = transitions[i];
      const dur = durations && durations[i];
      const isActive = dur && dur.exitedAt === null;
      html += '<div class="timeline-entry' + (isActive ? ' active' : '') + '">';
      html += '<div class="timeline-dot"></div>';
      html += '<div>';
      html += '<div class="timeline-state">' + esc(stateValueStr(t.to)) + '</div>';
      if (t.from !== null) {
        html += '<div class="timeline-event">from: ' + esc(stateValueStr(t.from)) + '</div>';
      }
      html += '<div class="timeline-time">' + formatTime(t.ts) + '</div>';
      if (dur) {
        html += '<div class="timeline-duration' + (isActive ? ' active-duration" data-entered="' + dur.enteredAt : '') + '">' + formatDuration(dur.durationMs) + '</div>';
      }
      // Show sleep countdown on the active state entry
      if (isActive && activeSleep) {
        var remaining = activeSleep.wakeAt - Date.now();
        var countdownText = remaining > 0 ? formatDuration(remaining) + ' remaining' : 'firing...';
        html += '<div class="sleep-countdown' + (remaining <= 0 ? ' firing' : '') + '" data-wake-at="' + activeSleep.wakeAt + '">' + countdownText + '</div>';
      }
      html += '</div></div>';
    }
    el.innerHTML = html;
  }

  // ── Live Duration Ticker ───────────────────────────────────

  let tickInterval = null;

  function startDurationTicker() {
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(function() {
      // Update elapsed duration on active states
      var els = document.querySelectorAll('.active-duration[data-entered]');
      for (var el of els) {
        var entered = parseInt(el.getAttribute('data-entered'));
        if (!isNaN(entered)) {
          el.textContent = formatDuration(Date.now() - entered);
        }
      }

      // Update sleep countdown badges
      var countdowns = document.querySelectorAll('.sleep-countdown[data-wake-at]');
      for (var cd of countdowns) {
        var wakeAt = parseInt(cd.getAttribute('data-wake-at'));
        if (!isNaN(wakeAt)) {
          var remaining = wakeAt - Date.now();
          if (remaining <= 0) {
            cd.textContent = 'firing...';
            cd.classList.add('firing');
          } else {
            cd.textContent = formatDuration(remaining) + ' remaining';
          }
        }
      }
    }, 200);
  }

  // ── Event Sender ───────────────────────────────────────────

  // Current event schemas from runtime-data or SSE updates
  var currentEventSchemas = {};

  function renderEventFieldsForType(container, eventType) {
    var schema = currentEventSchemas[eventType];
    if (!schema || schema.length === 0) {
      // No schema — show JSON textarea
      container.innerHTML = '<textarea name="payload" placeholder=\\'"key": "value"} (optional)\\'></textarea>';
      return;
    }
    // Render typed form fields
    var html = '';
    for (var i = 0; i < schema.length; i++) {
      var f = schema[i];
      var req = f.required ? ' required' : '';
      if (f.type === 'select') {
        html += '<label for="evt-' + f.name + '">' + f.label + '</label>';
        html += '<select name="evt-' + f.name + '" id="evt-' + f.name + '" data-field="' + f.name + '"' + req + '>';
        html += '<option value="">-- select --</option>';
        for (var j = 0; j < (f.options || []).length; j++) {
          html += '<option value="' + f.options[j] + '">' + f.options[j] + '</option>';
        }
        html += '</select>';
      } else if (f.type === 'checkbox') {
        html += '<label class="checkbox-label"><input type="checkbox" name="evt-' + f.name + '" data-field="' + f.name + '" value="true" /> ' + f.label + '</label>';
      } else {
        var inputType = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
        html += '<label for="evt-' + f.name + '">' + f.label + '</label>';
        html += '<input type="' + inputType + '" name="evt-' + f.name + '" id="evt-' + f.name + '" data-field="' + f.name + '" placeholder="' + f.label + '"' + req + ' />';
      }
    }
    container.innerHTML = html;
  }

  function collectEventFields(container) {
    var payload = {};
    var fields = container.querySelectorAll('[data-field]');
    for (var i = 0; i < fields.length; i++) {
      var el = fields[i];
      var name = el.getAttribute('data-field');
      if (el.type === 'checkbox') {
        payload[name] = el.checked;
      } else if (el.type === 'number') {
        if (el.value !== '') payload[name] = Number(el.value);
      } else {
        if (el.value !== '') payload[name] = el.value;
      }
    }
    return payload;
  }

  function initEventSender() {
    const form = document.getElementById('event-form');
    if (!form) return;

    var select = document.getElementById('event-type-select');
    var fieldsContainer = document.getElementById('event-fields');

    // Load initial schemas from runtime-data
    var rtEl = document.getElementById('runtime-data');
    if (rtEl) {
      try {
        var rtData = JSON.parse(rtEl.textContent);
        if (rtData.eventSchemas) currentEventSchemas = rtData.eventSchemas;
      } catch (e) {}
    }

    // When event type changes, update the fields container
    if (select && fieldsContainer) {
      select.addEventListener('change', function() {
        renderEventFieldsForType(fieldsContainer, select.value);
      });
    }

    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      const eventType = select ? select.value : '';
      if (!eventType) return;

      var status = form.querySelector('.form-status');
      var payload = {};

      if (fieldsContainer && currentEventSchemas[eventType]) {
        // Collect from typed fields
        payload = collectEventFields(fieldsContainer);
      } else {
        // Collect from JSON textarea
        var textarea = form.querySelector('textarea[name="payload"]');
        if (textarea && textarea.value.trim()) {
          try {
            payload = JSON.parse(textarea.value);
          } catch (err) {
            if (status) {
              status.textContent = 'Invalid JSON payload';
              status.className = 'form-status error';
            }
            return;
          }
        }
      }

      const event = Object.assign({ type: eventType }, payload);

      try {
        const resp = await fetch(form.action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
        if (resp.ok) {
          if (status) {
            status.textContent = 'Event sent';
            status.className = 'form-status success';
          }
          // Reset fields
          if (fieldsContainer && currentEventSchemas[eventType]) {
            renderEventFieldsForType(fieldsContainer, eventType);
          } else {
            var ta = form.querySelector('textarea[name="payload"]');
            if (ta) ta.value = '';
          }
        } else {
          const errData = await resp.json().catch(function() { return {}; });
          if (status) {
            status.textContent = errData.error || 'Failed to send event';
            status.className = 'form-status error';
          }
        }
      } catch (err) {
        if (status) {
          status.textContent = 'Network error';
          status.className = 'form-status error';
        }
      }
    });
  }

  // ── Cancel Button ─────────────────────────────────────────

  function initCancelButton() {
    var btn = document.getElementById('cancel-btn');
    if (!btn) return;

    btn.addEventListener('click', async function() {
      var url = btn.getAttribute('data-url');
      var status = document.getElementById('cancel-status');
      if (!url) return;

      if (!confirm('Cancel this instance? This cannot be undone.')) return;

      btn.disabled = true;
      try {
        var resp = await fetch(url, { method: 'DELETE' });
        if (resp.ok) {
          if (status) {
            status.textContent = 'Cancelled';
            status.className = 'form-status success';
          }
        } else {
          var errData = await resp.json().catch(function() { return {}; });
          if (status) {
            status.textContent = errData.error || 'Failed to cancel';
            status.className = 'form-status error';
          }
          btn.disabled = false;
        }
      } catch (err) {
        if (status) {
          status.textContent = 'Network error';
          status.className = 'form-status error';
        }
        btn.disabled = false;
      }
    });
  }

  // ── Start Instance Form ──────────────────────────────────

  function initStartForm() {
    var form = document.getElementById('start-form');
    if (!form) return;

    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      var url = form.getAttribute('data-url');
      var detailBase = form.getAttribute('data-detail-base');
      var idInput = form.querySelector('input[name="instanceId"]');
      var textArea = form.querySelector('textarea[name="input"]');
      var status = document.getElementById('start-status');
      var instanceId = idInput ? idInput.value.trim() : '';
      if (!instanceId) return;

      var input = {};
      var hasSchema = form.getAttribute('data-has-schema') === 'true';
      if (hasSchema) {
        // Collect from typed form fields
        var schemaFields = form.querySelectorAll('[data-field]');
        for (var i = 0; i < schemaFields.length; i++) {
          var el = schemaFields[i];
          var fname = el.getAttribute('data-field');
          if (el.type === 'checkbox') {
            input[fname] = el.checked;
          } else if (el.type === 'number') {
            if (el.value !== '') input[fname] = Number(el.value);
          } else {
            if (el.value !== '') input[fname] = el.value;
          }
        }
      } else if (textArea && textArea.value.trim()) {
        try {
          input = JSON.parse(textArea.value);
        } catch (err) {
          if (status) {
            status.textContent = 'Invalid JSON input';
            status.className = 'form-status error';
          }
          return;
        }
      }

      try {
        var resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instanceId: instanceId, input: input }),
        });
        if (resp.ok) {
          // Navigate to the new instance detail page
          window.location.href = detailBase + '/' + encodeURIComponent(instanceId);
        } else {
          var errData = await resp.json().catch(function() { return {}; });
          if (status) {
            status.textContent = errData.error || 'Failed to start instance';
            status.className = 'form-status error';
          }
        }
      } catch (err) {
        if (status) {
          status.textContent = 'Network error';
          status.className = 'form-status error';
        }
      }
    });
  }

  // ── SSE Live Updates ───────────────────────────────────────

  function connectSSE(url, handlers) {
    const indicator = document.querySelector('.sse-indicator');
    if (indicator) indicator.className = 'sse-indicator connecting';

    const es = new EventSource(url);

    es.onopen = function() {
      if (indicator) indicator.className = 'sse-indicator connected';
    };

    es.onerror = function() {
      if (indicator) indicator.className = 'sse-indicator disconnected';
    };

    for (const [event, handler] of Object.entries(handlers)) {
      es.addEventListener(event, function(e) {
        try {
          handler(JSON.parse(e.data));
        } catch (err) {
          console.error('SSE handler error:', err);
        }
      });
    }

    es.addEventListener('complete', function(e) {
      es.close();
      if (indicator) indicator.className = 'sse-indicator disconnected';
    });

    // Close on page navigation to free the HTTP/1.1 connection slot
    window.addEventListener('beforeunload', function() { es.close(); });

    return es;
  }

  function initInstanceDetailSSE() {
    const sseEl = document.getElementById('sse-url');
    if (!sseEl) return;
    const sseUrl = sseEl.textContent;
    const graphData = extractGraphDataFromPage();

    connectSSE(sseUrl, {
      state: function(data) {
        // Update context panel
        if (data.snapshot) {
          updateContextPanel(data.snapshot.context);

          // Update status badge
          const badge = document.getElementById('instance-status');
          if (badge) {
            badge.textContent = data.snapshot.status;
            badge.className = 'badge badge-' + data.snapshot.status;
          }

          // Disable cancel button when no longer running
          var cancelBtn = document.getElementById('cancel-btn');
          if (cancelBtn) {
            cancelBtn.disabled = data.snapshot.status !== 'running';
          }
        }

        // Update timeline
        if (data.transitions) {
          renderTimeline(data.transitions, data.stateDurations, data.activeSleep || null);
          startDurationTicker();
        }

        // Update event sender dropdown and schemas
        if (data.availableEvents) {
          const select = document.getElementById('event-type-select');
          if (select) {
            const current = select.value;
            select.innerHTML = '<option value="">-- select event --</option>';
            for (const evt of data.availableEvents) {
              select.innerHTML += '<option value="' + esc(evt) + '"' + (evt === current ? ' selected' : '') + '>' + esc(evt) + '</option>';
            }
          }
        }
        if (data.eventSchemas) {
          currentEventSchemas = data.eventSchemas;
          // Re-render fields if an event type is currently selected
          var evtSelect = document.getElementById('event-type-select');
          var fieldsContainer = document.getElementById('event-fields');
          if (evtSelect && fieldsContainer && evtSelect.value) {
            renderEventFieldsForType(fieldsContainer, evtSelect.value);
          }
        }

        // Update graph with new active states and analytics
        if (graphData && data.snapshot) {
          const activeStates = data.activeStates || [];
          const visitedStates = data.visitedStates || [];
          renderGraph(graphData, {
            activeStates: activeStates,
            visitedStates: visitedStates,
            activeSleep: data.activeSleep || null,
            aggregateStateDurations: data.aggregateStateDurations || null,
            transitionCounts: data.transitionCounts || null,
          });
        }

        // Update error panel
        updateErrorPanel(data.snapshot, data.steps, data.effects);

        // Update effects panel
        if (data.effects) {
          updateEffectsPanel(data.effects);
        }

        // Update event log
        if (data.eventLog) {
          updateEventLog(data.eventLog);
        }

        // Update analytics panel
        if (data.aggregateStateDurations || data.transitionCounts) {
          updateAnalyticsPanel(data.aggregateStateDurations, data.transitionCounts);
        }
      },
    });
  }

  function initInstanceListSSE() {
    const sseEl = document.getElementById('sse-url');
    if (!sseEl) return;
    const sseUrl = sseEl.textContent;

    connectSSE(sseUrl, {
      instances: function(data) {
        const tbody = document.getElementById('instance-tbody');
        if (!tbody || !data.instances) return;
        const basePath = document.getElementById('base-path')?.textContent || '';
        const machineId = document.getElementById('machine-id')?.textContent || '';

        let html = '';
        for (const inst of data.instances) {
          const statusLower = inst.status.toLowerCase();
          html += '<tr>';
          html += '<td class="mono"><a href="' + basePath + '/machines/' + esc(machineId) + '/instances/' + esc(inst.workflowId) + '">' + esc(inst.workflowId) + '</a></td>';
          html += '<td><span class="badge badge-' + esc(statusLower) + '">' + esc(inst.status) + '</span></td>';
          html += '</tr>';
        }
        tbody.innerHTML = html || '<tr><td colspan="2" class="empty">No instances</td></tr>';
      },
    });
  }

  function updateErrorPanel(snapshot, steps, effects) {
    var container = document.getElementById('error-panel-container');
    if (!container) return;

    var errors = [];

    if (snapshot && snapshot.status === 'error') {
      var ctx = snapshot.context || {};
      var errMsg = ctx.error || ctx.errorMessage || ctx.err;
      if (errMsg != null) {
        errors.push({
          source: 'Instance',
          message: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg, null, 2),
        });
      } else {
        errors.push({ source: 'Instance', message: 'Machine reached error status' });
      }
    }

    if (steps) {
      for (var i = 0; i < steps.length; i++) {
        if (steps[i].error != null) {
          errors.push({
            source: 'Step: ' + steps[i].name,
            message: typeof steps[i].error === 'string' ? steps[i].error : JSON.stringify(steps[i].error, null, 2),
          });
        }
      }
    }

    if (effects) {
      for (var j = 0; j < effects.length; j++) {
        if (effects[j].status === 'failed' && effects[j].lastError) {
          errors.push({
            source: 'Effect: ' + effects[j].effectType,
            message: effects[j].lastError,
          });
        }
      }
    }

    if (errors.length === 0) {
      container.innerHTML = '';
      return;
    }

    var html = '<div class="error-panel" id="error-panel"><h2>Errors</h2>';
    for (var k = 0; k < errors.length; k++) {
      html += '<div class="error-item">';
      html += '<div class="error-item-source">' + esc(errors[k].source) + '</div>';
      html += '<div class="error-item-message">' + esc(errors[k].message) + '</div>';
      html += '</div>';
    }
    html += '</div>';
    container.innerHTML = html;
  }

  function updateEffectsPanel(effects) {
    const el = document.getElementById('effects-list');
    if (!el) return;
    if (effects.length === 0) {
      el.innerHTML = '<div class="empty">No effects</div>';
      return;
    }
    let html = '';
    for (const eff of effects) {
      html += '<div class="effect-row">';
      html += '<span class="effect-type">' + esc(eff.effectType) + '</span>';
      html += '<span class="badge badge-' + esc(eff.status) + '">' + esc(eff.status) + '</span>';
      if (eff.attempts > 0) html += '<span class="timeline-duration">' + eff.attempts + '/' + eff.maxAttempts + ' attempts</span>';
      html += '</div>';
    }
    el.innerHTML = html;
  }

  function updateEventLog(entries) {
    const el = document.getElementById('event-log-entries');
    if (!el) return;
    if (entries.length === 0) {
      el.innerHTML = '<div class="empty">No events</div>';
      return;
    }
    let html = '';
    for (const entry of entries) {
      html += '<div class="event-log-entry">';
      html += '<span class="event-log-seq">#' + entry.seq + '</span>';
      html += '<span class="event-log-topic">' + esc(entry.topic) + '</span>';
      html += '<span class="event-log-time">' + formatTime(entry.createdAt) + '</span>';
      html += '</div>';
    }
    el.innerHTML = html;
  }

  function updateAnalyticsPanel(aggDurations, transCounts) {
    var el = document.getElementById('analytics-content');
    if (!el) return;
    var html = '';
    if (aggDurations && aggDurations.length > 0) {
      html += '<h3 style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Aggregate State Durations</h3>';
      html += '<table><thead><tr><th>State</th><th>Avg</th><th>Min</th><th>Max</th><th>Count</th></tr></thead><tbody>';
      for (var i = 0; i < aggDurations.length; i++) {
        var d = aggDurations[i];
        var sv = typeof d.stateValue === 'string' ? d.stateValue : JSON.stringify(d.stateValue);
        html += '<tr><td class="mono">' + esc(sv) + '</td><td class="mono">' + formatDuration(d.avgMs) + '</td><td class="mono">' + formatDuration(d.minMs) + '</td><td class="mono">' + formatDuration(d.maxMs) + '</td><td class="mono">' + d.count + '</td></tr>';
      }
      html += '</tbody></table>';
    }
    if (transCounts && transCounts.length > 0) {
      html += '<h3 style="font-size:12px;color:var(--text-dim);margin:16px 0 8px">Transition Counts</h3>';
      html += '<table><thead><tr><th>From</th><th>To</th><th>Event</th><th>Count</th></tr></thead><tbody>';
      for (var j = 0; j < transCounts.length; j++) {
        var t = transCounts[j];
        var fromSv = t.fromState != null ? (typeof t.fromState === 'string' ? t.fromState : JSON.stringify(t.fromState)) : '-';
        var toSv = typeof t.toState === 'string' ? t.toState : JSON.stringify(t.toState);
        html += '<tr><td class="mono">' + esc(fromSv) + '</td><td class="mono">' + esc(toSv) + '</td><td class="mono">' + esc(t.event || '-') + '</td><td class="mono">' + t.count + '</td></tr>';
      }
      html += '</tbody></table>';
    }
    el.innerHTML = html;
  }

  // ── Utilities ──────────────────────────────────────────────

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Initialization ────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function() {
    const graphData = extractGraphDataFromPage();
    const runtimeState = extractRuntimeState();

    if (graphData) {
      renderGraph(graphData, runtimeState);
    }

    // Start ticker for both duration and sleep countdown
    startDurationTicker();

    initEventSender();
    initCancelButton();
    initStartForm();
    initInstanceDetailSSE();
    initInstanceListSSE();
  });
})();
`;
