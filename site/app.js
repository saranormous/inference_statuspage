const DATA_ROOT = 'parsed';
const INCIDENTS_URL = `${DATA_ROOT}/incidents.jsonl`;
const WINDOWS_URL = `${DATA_ROOT}/downtime_windows.csv`;
const PROVIDERS_URL = `${DATA_ROOT}/providers.json`;
const PROBE_URL = 'https://raw.githubusercontent.com/saranormous/inference_statuspage/data/parsed/probe_results.jsonl';

const PROVIDER_COLORS = {
  fireworks: '#f97316',
  together: '#10b981',
  baseten: '#ec4899',
};

const PROVIDER_NAMES = {
  fireworks: 'Fireworks AI',
  together: 'Together AI',
  baseten: 'Baseten',
};

const PROVIDER_ORDER = ['baseten', 'fireworks', 'together'];

const WINDOW_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const WINDOW_LABELS = { '24h': '24h', '7d': '7d', '30d': '30d' };

const BUCKET_CONFIG = {
  '24h': 288,
  '7d': 336,
  '30d': 360,
};

// Periods excluded from aggregates for ALL providers (e.g. billing issues on our side).
// Probes during these windows are dropped before stats are computed.
const EXCLUSION_WINDOWS = [
  { start: '2026-03-30T11:25:00Z', end: '2026-03-30T18:55:00Z', reason: 'Fireworks billing tier issue caused 412s' },
];

const isExcluded = (timestamp) => {
  const t = new Date(timestamp).getTime();
  return EXCLUSION_WINDOWS.some(w => t >= new Date(w.start).getTime() && t <= new Date(w.end).getTime());
};

let currentWindow = '24h';
let cachedProbeData = null;

const impactRank = { none: 0, maintenance: 1, minor: 2, major: 3 };
const impactLabel = { none: 'Operational', maintenance: 'Maintenance', minor: 'Minor', major: 'Major' };
const impactSummary = { none: 'Operational', maintenance: 'Maintenance', minor: 'Partial outage', major: 'Major outage' };

const formatDate = (date) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);

const formatTime = (date) =>
  new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(date);

const incidentStartDate = (inc) =>
  inc.downtime_start ? new Date(inc.downtime_start) : new Date(inc.published_at);

const parseJSONL = (text) =>
  text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

const parseCSVLine = (line) => {
  const values = [];
  let current = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i + 1] === '"') { current += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { values.push(current); current = ''; }
    else current += c;
  }
  values.push(current);
  return values;
};

const parseCSV = (text) => {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = parseCSVLine(lines.shift());
  return lines.map((line) => {
    const cols = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    return row;
  });
};

const getDayStartUTC = (date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const clipInterval = (start, end, rangeStart, rangeEnd) => {
  const s = Math.max(start.getTime(), rangeStart.getTime());
  const e = Math.min(end.getTime(), rangeEnd.getTime());
  return e <= s ? null : [new Date(s), new Date(e)];
};

const mergeIntervals = (intervals) => {
  if (!intervals.length) return [];
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur[0] <= last[1]) last[1] = new Date(Math.max(last[1].getTime(), cur[1].getTime()));
    else merged.push(cur);
  }
  return merged;
};

const minutesBetween = (start, end) => Math.max(0, Math.ceil(end.getTime() / 60000) - Math.floor(start.getTime() / 60000));

const formatDuration = (minutes) => {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.length ? parts.join(' ') : '0m';
};

const countsAsDowntime = (impact) => impact !== 'maintenance';
const severityToImpact = (sev) => Object.keys(impactRank).find((k) => impactRank[k] === sev) || 'none';

/* =========================================================
   PROBE DATA — Independent monitoring
   ========================================================= */

const renderProbeData = async () => {
  try {
    const resp = await fetch(PROBE_URL);
    if (!resp.ok) throw new Error('No probe data yet');
    const text = await resp.text();
    cachedProbeData = parseJSONL(text);
  } catch {
    return;
  }

  if (!cachedProbeData.length) return;

  renderWithWindow(currentWindow);

  // Update last probe time + live dot state
  const latest = cachedProbeData.reduce((max, p) => p.timestamp > max ? p.timestamp : max, '');
  if (latest) {
    const el = document.getElementById('probeLastUpdated');
    const dot = document.querySelector('.live-dot');
    const ago = Math.round((Date.now() - new Date(latest).getTime()) / 60000);
    if (ago > 60) {
      el.textContent = `Last probe ${ago}m ago — stale`;
      el.style.color = 'var(--major)';
      if (dot) { dot.style.background = 'var(--major)'; dot.style.animation = 'none'; }
    } else if (ago > 15) {
      el.textContent = `Last probe ${ago}m ago — possible gap`;
      el.style.color = 'var(--minor)';
      if (dot) { dot.style.background = 'var(--minor)'; dot.style.animation = 'none'; }
    } else {
      el.textContent = ago <= 1 ? 'Updated just now' : `Updated ${ago}m ago`;
      el.style.color = '';
      if (dot) { dot.style.background = ''; dot.style.animation = ''; }
    }
  }

  // Show probe region if available
  const regionEl = document.getElementById('probeRegion');
  if (regionEl) {
    const lastProbe = cachedProbeData[cachedProbeData.length - 1];
    const region = lastProbe?.probe_region;
    if (region && region !== 'local') {
      regionEl.textContent = region;
    } else if (region === 'local') {
      regionEl.textContent = 'local machine';
    }
  }
};

const renderWithWindow = (windowKey) => {
  const tier1 = cachedProbeData.filter((p) => p.tier === 'inference_api');
  if (tier1.length) renderMonitoringGrid('tier1Grid', tier1, windowKey);
};

const buildLatencySparkline = (points, color) => {
  const filled = points.map((v, i) => v != null ? { i, v } : null).filter(Boolean);
  if (filled.length < 4) return '';
  const W = 200, H = 28, pad = 2;
  const yMin = Math.min(...filled.map((p) => p.v));
  const yMax = Math.max(...filled.map((p) => p.v));
  const yRange = yMax - yMin || 1;
  const xOf = (i) => pad + (i / (points.length - 1)) * (W - 2 * pad);
  const yOf = (v) => pad + (1 - (v - yMin) / yRange) * (H - 2 * pad);
  const pathParts = filled.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${xOf(p.i).toFixed(1)},${yOf(p.v).toFixed(1)}`);
  const areaPath = [...pathParts, `L${xOf(filled[filled.length - 1].i).toFixed(1)},${H}`, `L${xOf(filled[0].i).toFixed(1)},${H}Z`].join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="latency-spark" preserveAspectRatio="none">
    <path d="${areaPath}" fill="${color}" opacity="0.1"/>
    <path d="${pathParts.join('')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
};

const renderMonitoringGrid = (containerId, probeResults, windowKey) => {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  container.classList.remove('monitoring-grid');
  container.classList.add('monitoring-grid');

  const windowMs = WINDOW_MS[windowKey];
  const windowLabel = WINDOW_LABELS[windowKey];
  const bucketCount = BUCKET_CONFIG[windowKey];

  // Group by provider
  const byProvider = new Map();
  probeResults.forEach((p) => {
    if (!byProvider.has(p.provider)) byProvider.set(p.provider, []);
    byProvider.get(p.provider).push(p);
  });

  const now = Date.now();

  PROVIDER_ORDER.forEach((key) => {
    const results = byProvider.get(key);
    if (!results) return;

    const recent = results.filter((r) => now - new Date(r.timestamp).getTime() < windowMs && !isExcluded(r.timestamp));
    if (!recent.length) return;

    const successes = recent.filter((r) => r.success);
    const failures = recent.filter((r) => !r.success);
    const availability = recent.length ? (successes.length / recent.length * 100) : 0;

    // Error type breakdown
    const errorCounts = {};
    failures.forEach((r) => {
      const t = r.error_type || 'unknown';
      errorCounts[t] = (errorCounts[t] || 0) + 1;
    });
    const latencies = successes.map((r) => r.latency_ms).sort((a, b) => a - b);
    const ttfts = successes.map((r) => r.ttft_ms).filter((v) => v != null).sort((a, b) => a - b);
    const MIN_SAMPLES = 20;
    const enoughData = latencies.length >= MIN_SAMPLES;
    const p50 = enoughData ? latencies[Math.floor(latencies.length * 0.5)] : null;
    const p95 = enoughData ? latencies[Math.floor(latencies.length * 0.95)] : null;
    const p99 = enoughData ? latencies[Math.floor(latencies.length * 0.99)] : null;
    const ttftP50 = (ttfts.length >= MIN_SAMPLES) ? ttfts[Math.floor(ttfts.length * 0.5)] : null;

    // Build sparkline
    const bucketSize = windowMs / bucketCount;
    const buckets = new Array(bucketCount).fill(null);
    recent.forEach((r) => {
      const age = now - new Date(r.timestamp).getTime();
      const idx = bucketCount - 1 - Math.floor(age / bucketSize);
      if (idx >= 0 && idx < bucketCount) {
        if (buckets[idx] === null) buckets[idx] = r.success;
        else if (!r.success) buckets[idx] = false;
      }
    });

    // Build latency sparkline (p50 per bucket)
    const latencyBuckets = Array.from({ length: bucketCount }, () => []);
    recent.forEach((r) => {
      if (!r.success || r.latency_ms == null) return;
      const age = now - new Date(r.timestamp).getTime();
      const idx = bucketCount - 1 - Math.floor(age / bucketSize);
      if (idx >= 0 && idx < bucketCount) latencyBuckets[idx].push(r.latency_ms);
    });
    const latencyPoints = latencyBuckets.map((vals) => {
      if (!vals.length) return null;
      const s = vals.sort((a, b) => a - b);
      return s[Math.floor(s.length * 0.5)];
    });

    // For early data, show last probe's raw values
    const lastSuccess = successes[successes.length - 1];
    const lastTtft = lastSuccess?.ttft_ms;
    const lastLatency = lastSuccess?.latency_ms;
    const failCount = failures.length;

    const ERROR_LABELS = { timeout: 'Timeouts', rate_limit: 'Rate limited', auth: 'Auth errors', server_error: 'Server errors', client_error: 'Client errors', connection: 'Connection errors', unknown: 'Other errors' };
    const errorRows = Object.entries(errorCounts).map(([t, n]) =>
      `<div class="stat-row"><span class="stat-label">${ERROR_LABELS[t] || t}</span><span class="stat-value error-value">${n}</span></div>`
    ).join('');

    const failureRows = failCount > 0
      ? `<div class="stat-row"><span class="stat-label">Failures</span><span class="stat-value error-value">${failCount}</span></div>${errorRows}`
      : `<div class="stat-row"><span class="stat-label">Failures</span><span class="stat-value">${failCount}</span></div>`;

    const statsHtml = enoughData ? `
      <div class="monitor-stats">
        <div class="stat-row"><span class="stat-label">TTFT p50</span><span class="stat-value">${ttftP50 != null ? `${Math.round(ttftP50)}ms` : '—'}</span></div>
        <div class="stat-row"><span class="stat-label">Latency p50</span><span class="stat-value">${Math.round(p50)}ms</span></div>
        <div class="stat-row"><span class="stat-label">Latency p95</span><span class="stat-value">${Math.round(p95)}ms</span></div>
        <div class="stat-row"><span class="stat-label">Latency p99</span><span class="stat-value">${Math.round(p99)}ms</span></div>
        <div class="stat-row"><span class="stat-label">Probes (${windowLabel})</span><span class="stat-value">${recent.length}</span></div>
        ${failureRows}
      </div>
    ` : `
      <div class="monitor-stats">
        <div class="stat-row"><span class="stat-label">Last TTFT</span><span class="stat-value">${lastTtft != null ? `${Math.round(lastTtft)}ms` : '—'}</span></div>
        <div class="stat-row"><span class="stat-label">Last latency</span><span class="stat-value">${lastLatency != null ? `${Math.round(lastLatency)}ms` : '—'}</span></div>
        <div class="stat-row"><span class="stat-label">Probes (${windowLabel})</span><span class="stat-value">${recent.length}</span></div>
        ${failureRows}
      </div>
      <div class="monitor-note">Percentiles after ${MIN_SAMPLES}+ probes</div>
    `;

    const card = document.createElement('div');
    card.className = 'monitor-card';
    card.innerHTML = `
      <div class="monitor-header">
        <span class="provider-dot" style="background:${PROVIDER_COLORS[key]}"></span>
        <strong>${PROVIDER_NAMES[key]}</strong>
      </div>
      <div class="monitor-availability ${availability >= 99.9 ? 'good' : availability >= 99 ? 'warn' : 'bad'}">
        ${availability.toFixed(1)}%
      </div>
      <div class="monitor-label">${windowLabel} availability</div>
      ${buckets.filter((b) => b !== null).length >= 6 ? `<div class="monitor-sparkline">${buckets.map((b) =>
        `<span class="${b === null ? 'no-data' : b ? 'up' : 'down'}"></span>`
      ).join('')}</div>` : ''}
      ${(() => {
        const svg = buildLatencySparkline(latencyPoints, PROVIDER_COLORS[key]);
        if (!svg) return '';
        const filledPts = latencyPoints.filter((v) => v != null);
        const lo = Math.round(Math.min(...filledPts));
        const hi = Math.round(Math.max(...filledPts));
        return `<div class="latency-sparkline-wrap">
          <div class="latency-spark-label">
            <span>p50 latency</span>
            <span class="latency-spark-range">${lo === hi ? `${lo}ms` : `${lo}–${hi}ms`}</span>
          </div>
          ${svg}
        </div>`;
      })()}
      ${statsHtml}
    `;
    card.addEventListener('click', () => {
      renderDetailPanel(key, probeResults, windowKey);
    });
    container.appendChild(card);
  });
};

/* =========================================================
   DETAIL PANEL — Click-to-expand probe detail
   ========================================================= */

let openDetailProvider = null;

const fmtMs = (v) => v >= 10000 ? `${(v / 1000).toFixed(0)}s` : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;

const niceStep = (range, count) => {
  const rough = range / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  return [1, 2, 2.5, 5, 10].map(n => n * mag).find(n => n >= rough) || rough;
};

const buildLatencyChart = (probes, providerKey, windowKey) => {
  const W = 780, H = 200;
  const M = { top: 12, right: 12, bottom: 28, left: 52 };
  const pw = W - M.left - M.right, ph = H - M.top - M.bottom;
  const now = Date.now(), windowMs = WINDOW_MS[windowKey], tMin = now - windowMs;

  const successes = probes.filter(p => p.success);
  const allVals = successes.flatMap(p => [p.latency_ms, p.ttft_ms].filter(v => v != null));
  if (!allVals.length && !probes.some(p => !p.success)) return '';

  const yMax = allVals.length ? Math.ceil(Math.max(...allVals) * 1.15) : 1000;
  const xOf = (t) => M.left + ((new Date(t).getTime() - tMin) / windowMs) * pw;
  const yOf = (v) => M.top + ph - (v / yMax) * ph;

  const step = niceStep(yMax, 5);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="latency-svg">`;

  // Y gridlines + labels
  for (let v = step; v <= yMax; v += step) {
    const y = yOf(v);
    svg += `<line x1="${M.left}" y1="${y}" x2="${W - M.right}" y2="${y}" stroke="var(--border)" stroke-width="0.5" opacity="0.5"/>`;
    svg += `<text x="${M.left - 8}" y="${y + 3.5}" text-anchor="end" fill="var(--muted)" font-size="9.5" font-family="var(--code)">${fmtMs(v)}</text>`;
  }
  svg += `<line x1="${M.left}" y1="${yOf(0)}" x2="${W - M.right}" y2="${yOf(0)}" stroke="var(--border)" stroke-width="0.5"/>`;

  // X labels
  const showDate = windowMs > 2 * 86400000;
  const xTicks = windowKey === '24h' ? 6 : windowKey === '7d' ? 7 : 6;
  for (let i = 1; i < xTicks; i++) {
    const t = tMin + (windowMs / xTicks) * i;
    const d = new Date(t);
    const label = showDate
      ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
      : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    svg += `<text x="${xOf(t)}" y="${H - 5}" text-anchor="middle" fill="var(--muted)" font-size="9.5" font-family="var(--code)">${label}</text>`;
  }

  const r = probes.length > 1000 ? 1.5 : probes.length > 300 ? 2 : 2.5;

  // Failed probes — faint vertical line + red dot at top
  probes.filter(p => !p.success).forEach(p => {
    const x = xOf(p.timestamp);
    svg += `<line x1="${x}" y1="${M.top}" x2="${x}" y2="${M.top + ph}" stroke="var(--major)" stroke-width="1" opacity="0.15"/>`;
    svg += `<circle cx="${x}" cy="${M.top + 8}" r="3.5" fill="var(--major)" opacity="0.8"><title>Failed: ${p.error_type || 'unknown'} — ${new Date(p.timestamp).toISOString().slice(11, 16)} UTC</title></circle>`;
  });

  // TTFT dots (lighter)
  successes.forEach(p => {
    if (p.ttft_ms == null) return;
    svg += `<circle cx="${xOf(p.timestamp)}" cy="${yOf(p.ttft_ms)}" r="${r}" fill="${PROVIDER_COLORS[providerKey]}" opacity="0.3"><title>TTFT ${Math.round(p.ttft_ms)}ms — ${new Date(p.timestamp).toISOString().slice(11, 16)} UTC</title></circle>`;
  });

  // Latency dots
  successes.forEach(p => {
    svg += `<circle cx="${xOf(p.timestamp)}" cy="${yOf(p.latency_ms)}" r="${r}" fill="${PROVIDER_COLORS[providerKey]}" opacity="0.8"><title>${Math.round(p.latency_ms)}ms — ${new Date(p.timestamp).toISOString().slice(11, 16)} UTC</title></circle>`;
  });

  svg += '</svg>';
  return svg;
};

const buildProbeTable = (probes) => {
  const rows = [...probes].reverse().slice(0, 30);
  const ths = '<tr><th>Time (UTC)</th><th>Status</th><th>TTFT</th><th>Latency</th><th>Error</th></tr>';
  const trs = rows.map(p => {
    const t = new Date(p.timestamp);
    const time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    const date = t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `<tr>
      <td>${date} ${time}</td>
      <td>${p.success ? '<span class="probe-ok">OK</span>' : '<span class="probe-fail">FAIL</span>'}</td>
      <td>${p.success && p.ttft_ms != null ? Math.round(p.ttft_ms) + 'ms' : '—'}</td>
      <td>${p.success ? Math.round(p.latency_ms) + 'ms' : '—'}</td>
      <td class="error-cell">${p.error_type || ''}</td>
    </tr>`;
  }).join('');
  return `<table class="probe-table"><thead>${ths}</thead><tbody>${trs}</tbody></table>`;
};

const closeDetailPanel = () => {
  const grid = document.getElementById('tier1Grid');
  grid.classList.remove('grid-hidden');
  const existing = document.querySelector('.detail-panel');
  if (existing) existing.remove();
  openDetailProvider = null;
};

const renderDetailPanel = (providerKey, allProbes, windowKey) => {
  const grid = document.getElementById('tier1Grid');

  if (openDetailProvider === providerKey) { closeDetailPanel(); return; }
  closeDetailPanel();
  openDetailProvider = providerKey;

  const windowMs = WINDOW_MS[windowKey];
  const now = Date.now();
  const probes = allProbes
    .filter(p => p.provider === providerKey && now - new Date(p.timestamp).getTime() < windowMs && !isExcluded(p.timestamp))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  if (!probes.length) return;

  grid.classList.add('grid-hidden');

  const panel = document.createElement('div');
  panel.className = 'detail-panel';
  panel.dataset.provider = providerKey;

  panel.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">
        <span class="provider-dot" style="background:${PROVIDER_COLORS[providerKey]}"></span>
        <strong>${PROVIDER_NAMES[providerKey]}</strong>
        <span class="muted-inline">— ${WINDOW_LABELS[windowKey]} probe detail</span>
      </div>
      <button class="detail-close" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M5 13L13 5M5 5l8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        Back
      </button>
    </div>
    <div class="detail-chart">${buildLatencyChart(probes, providerKey, windowKey)}</div>
    <div class="detail-legend">
      <span class="legend-item"><span class="dot" style="background:${PROVIDER_COLORS[providerKey]};opacity:0.35"></span>TTFT</span>
      <span class="legend-item"><span class="dot" style="background:${PROVIDER_COLORS[providerKey]}"></span>Total latency</span>
      <span class="legend-item"><span class="dot" style="background:var(--major)"></span>Failed</span>
    </div>
    <div class="detail-table-wrap">${buildProbeTable(probes)}</div>
  `;

  grid.after(panel);

  panel.querySelector('.detail-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeDetailPanel();
  });

  requestAnimationFrame(() => panel.classList.add('open'));
};

/* =========================================================
   INCIDENT DATA — Self-reported
   ========================================================= */

const compute90DayStats = (windows, rangeStart, rangeEnd) => {
  const daySeverity = new Array(90).fill(0);
  const dayIncidents = Array.from({ length: 90 }, () => new Map());
  const clippedIntervals = [];

  windows.forEach((entry) => {
    const clipped = clipInterval(entry.start, entry.end, rangeStart, rangeEnd);
    if (!clipped) return;
    const impact = entry.impact || 'none';
    if (countsAsDowntime(impact)) clippedIntervals.push(clipped);

    let current = getDayStartUTC(clipped[0]);
    const lastDay = getDayStartUTC(clipped[1]);
    while (current <= lastDay) {
      const index = Math.floor((current - rangeStart) / 86400000);
      if (index >= 0 && index < 90) {
        daySeverity[index] = Math.max(daySeverity[index], impactRank[impact] ?? 0);
        const id = entry.id || entry.title;
        const existing = dayIncidents[index].get(id);
        if (!existing || (impactRank[impact] ?? 0) > (impactRank[existing.impact] ?? 0)) {
          dayIncidents[index].set(id, { id, title: entry.title, impact, start: entry.start, end: entry.end, url: entry.url });
        }
      }
      current = new Date(current.getTime() + 86400000);
    }
  });

  const merged = mergeIntervals(clippedIntervals);
  const downtimeMinutes = merged.reduce((sum, [s, e]) => sum + minutesBetween(s, e), 0);
  const totalMinutes = 90 * 24 * 60;
  const uptime = Math.max(0, 1 - downtimeMinutes / totalMinutes);

  return { daySeverity, dayIncidents, clippedIntervals, merged, downtimeMinutes, uptime };
};

const renderIncidents = async () => {
  const [incidentsText, windowsText] = await Promise.all([
    fetch(INCIDENTS_URL).then((r) => r.text()),
    fetch(WINDOWS_URL).then((r) => r.text()),
  ]);

  const allIncidents = parseJSONL(incidentsText);
  const allWindows = parseCSV(windowsText);

  allIncidents.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  const now = new Date();
  const today = getDayStartUTC(now);
  const rangeStart = new Date(today);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - 89);
  const rangeEnd = new Date(today);
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 1);
  const since = rangeStart.getTime();

  const incidentById = new Map();
  allIncidents.forEach((inc) => { if (inc.id) incidentById.set(String(inc.id), inc); });

  const windowEntries = allWindows.map((row) => {
    if (!row.downtime_start || !row.downtime_end) return null;
    const start = new Date(row.downtime_start);
    const end = new Date(row.downtime_end);
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    return { id: row.incident_id, title: row.title || 'Incident', impact: row.impact || 'none', start, end, provider: row.provider, url: incidentById.get(String(row.incident_id || ''))?.url || null };
  }).filter(Boolean);

  // Per-provider
  const providerStats = {};
  PROVIDER_ORDER.forEach((key) => {
    const wins = windowEntries.filter((w) => w.provider === key);
    const incs = allIncidents.filter((i) => i.provider === key);
    const stats = compute90DayStats(wins, rangeStart, rangeEnd);
    const recentIncidents = incs.filter((i) => incidentStartDate(i).getTime() >= since);
    providerStats[key] = { ...stats, incidents: incs, recentIncidents, windows: wins };
  });

  // --- 90-day uptime bars ---
  const container = document.getElementById('providerUptimeRows');
  container.innerHTML = '';

  PROVIDER_ORDER.forEach((key) => {
    const s = providerStats[key];
    const row = document.createElement('div');
    row.className = 'uptime-row';

    const label = document.createElement('div');
    label.className = 'uptime-label';
    label.innerHTML = `<span><span class="provider-dot" style="background:${PROVIDER_COLORS[key]}"></span>${PROVIDER_NAMES[key]}</span><span class="uptime-note">${s.recentIncidents.length} reported incident${s.recentIncidents.length !== 1 ? 's' : ''}</span>`;
    row.appendChild(label);

    const bars = document.createElement('div');
    bars.className = 'uptime-bars';
    s.daySeverity.forEach((sev, idx) => {
      const span = document.createElement('span');
      const impact = severityToImpact(sev);
      span.className = impact === 'none' ? 'operational' : impact;
      span.dataset.dayIndex = String(idx);
      span.tabIndex = 0;
      bars.appendChild(span);
    });
    row.appendChild(bars);

    const tooltip = document.createElement('div');
    tooltip.className = 'uptime-tooltip';
    tooltip.setAttribute('aria-hidden', 'true');
    row.appendChild(tooltip);

    container.appendChild(row);
    attachTooltip(bars, tooltip, row, s.daySeverity, s.dayIncidents, rangeStart);
  });

  // --- Per-provider incident timelines ---
  const timelinesContainer = document.getElementById('providerTimelines');
  timelinesContainer.innerHTML = '';

  PROVIDER_ORDER.forEach((key) => {
    const s = providerStats[key];
    if (!s.recentIncidents.length) return;

    const section = document.createElement('section');
    section.className = 'panel provider-timeline-panel';
    section.setAttribute('data-animate', '');

    const header = document.createElement('div');
    header.className = 'panel-header';
    header.innerHTML = `
      <h3><span class="provider-dot" style="background:${PROVIDER_COLORS[key]}"></span>${PROVIDER_NAMES[key]}</h3>
      <span class="muted">${s.recentIncidents.length} self-reported in last 90 days</span>
    `;
    section.appendChild(header);

    const reportingNote = document.createElement('p');
    reportingNote.className = 'reporting-note';
    if (key === 'fireworks' || key === 'together') {
      reportingNote.textContent = 'Reports per-model-endpoint events via automated BetterStack monitoring.';
    } else if (key === 'baseten') {
      reportingNote.textContent = 'Reports incidents via Atlassian Statuspage with human-assigned severity.';
    }
    section.appendChild(reportingNote);

    const timeline = document.createElement('div');
    timeline.className = 'incident-timeline';

    const grouped = new Map();
    s.recentIncidents.forEach((inc) => {
      const date = formatDate(incidentStartDate(inc));
      if (!grouped.has(date)) grouped.set(date, []);
      grouped.get(date).push(inc);
    });

    const entries = Array.from(grouped.entries());
    let showAll = false;
    const INITIAL_SHOW = 3;

    const doRender = () => {
      timeline.innerHTML = '';
      const slice = showAll ? entries : entries.slice(0, INITIAL_SHOW);
      slice.forEach(([date, list]) => {
        const group = document.createElement('div');
        group.className = 'incident-group';
        const heading = document.createElement('h4');
        heading.textContent = date;
        group.appendChild(heading);
        list.forEach((inc) => group.appendChild(renderIncidentCard(inc)));
        timeline.appendChild(group);
      });
    };

    doRender();
    section.appendChild(timeline);

    if (entries.length > INITIAL_SHOW) {
      const footer = document.createElement('div');
      footer.className = 'timeline-footer';
      const btn = document.createElement('button');
      btn.className = 'ghost-button';
      btn.textContent = `Show all ${entries.length} dates`;
      btn.addEventListener('click', () => {
        showAll = !showAll;
        btn.textContent = showAll ? 'Show fewer' : `Show all ${entries.length} dates`;
        doRender();
      });
      footer.appendChild(btn);
      section.appendChild(footer);
    }

    timelinesContainer.appendChild(section);
  });
};

const renderIncidentCard = (incident) => {
  const card = document.createElement('div');
  card.className = 'incident-card';

  const titleRow = document.createElement('div');
  titleRow.className = 'incident-title';

  const title = document.createElement('h5');
  // Strip markdown bold markers from titles
  const cleanTitle = (incident.title || 'Incident').replace(/\*\*/g, '');
  if (incident.url) {
    const link = document.createElement('a');
    link.href = incident.url;
    link.textContent = cleanTitle;
    link.target = '_blank';
    link.rel = 'noreferrer';
    title.appendChild(link);
  } else {
    title.textContent = cleanTitle;
  }
  titleRow.appendChild(title);

  const badge = document.createElement('span');
  const impact = incident.impact || 'none';
  badge.className = `badge ${impact}`;
  badge.textContent = impactLabel[impact] || 'Operational';
  titleRow.appendChild(badge);

  card.appendChild(titleRow);

  const meta = document.createElement('div');
  meta.className = 'incident-meta';
  const start = incidentStartDate(incident);
  const dur = incident.duration_minutes;
  meta.textContent = `${formatTime(start)} UTC · ${dur != null ? formatDuration(dur) : '—'}`;
  card.appendChild(meta);

  if (incident.components?.length) {
    const compRow = document.createElement('div');
    compRow.className = 'components';
    incident.components.slice(0, 4).forEach((comp) => {
      const tag = document.createElement('span');
      tag.textContent = comp;
      compRow.appendChild(tag);
    });
    if (incident.components.length > 4) {
      const more = document.createElement('span');
      more.textContent = `+${incident.components.length - 4}`;
      compRow.appendChild(more);
    }
    card.appendChild(compRow);
  }

  if (incident.updates?.length > 1) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${incident.updates.length} updates`;
    details.appendChild(summary);
    const list = document.createElement('ul');
    incident.updates.forEach((upd) => {
      const li = document.createElement('li');
      const time = new Date(upd.at);
      li.textContent = `${formatTime(time)} UTC · ${upd.status} — ${upd.message}`;
      list.appendChild(li);
    });
    details.appendChild(list);
    card.appendChild(details);
  }

  return card;
};

/* =========================================================
   TOOLTIPS
   ========================================================= */

const attachTooltip = (bars, tooltip, container, severityByDay, incidentsByDay, startDate) => {
  const state = tooltip._tooltipState || (tooltip._tooltipState = { hideTimeout: null });

  const positionTooltip = (target) => {
    const panelRect = container.getBoundingClientRect();
    const barRect = target.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const padding = 12;
    let left = barRect.left - panelRect.left + barRect.width / 2;
    left = Math.max(tooltipRect.width / 2 + padding, Math.min(left, panelRect.width - tooltipRect.width / 2 - padding));
    let top = barRect.top - panelRect.top - tooltipRect.height - 12;
    if (top < padding) top = barRect.bottom - panelRect.top + 12;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    const tooltipLeft = left - tooltipRect.width / 2;
    const arrowLeft = barRect.left - panelRect.left + barRect.width / 2 - tooltipLeft;
    tooltip.style.setProperty('--arrow-left', `${arrowLeft}px`);
    tooltip.dataset.arrow = 'top';
  };

  const showTooltip = (target) => {
    if (state.hideTimeout) { window.clearTimeout(state.hideTimeout); state.hideTimeout = null; }
    container.classList.add('tooltip-open');
    const panel = container.closest('.panel');
    if (panel) panel.style.zIndex = '50';
    const idx = Number(target.dataset.dayIndex || 0);
    const date = new Date(startDate.getTime() + idx * 86400000);
    const dayStart = getDayStartUTC(date);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const incidents = Array.from(incidentsByDay[idx]?.values() || []);
    const severity = severityByDay[idx] ?? 0;
    const impact = severityToImpact(severity);
    const downtimeIntervals = incidents.filter((i) => countsAsDowntime(i.impact)).map((i) => {
      const s = i.start instanceof Date ? i.start : new Date(i.start);
      const e = i.end instanceof Date ? i.end : new Date(i.end);
      return clipInterval(s, e, dayStart, dayEnd);
    }).filter(Boolean);
    const merged = mergeIntervals(downtimeIntervals);
    const dm = merged.reduce((sum, [s, e]) => sum + minutesBetween(s, e), 0);
    const duration = dm > 0 ? formatDuration(dm) : '';

    const incList = incidents.length
      ? `<ul class="tooltip-incidents">${incidents.slice(0, 4).map((i) =>
          i.url ? `<li><a href="${i.url}" target="_blank" rel="noreferrer">${i.title}</a></li>` : `<li>${i.title}</li>`
        ).join('')}</ul>`
      : '<p class="tooltip-incidents">No incidents reported.</p>';

    tooltip.innerHTML = `
      <div class="tooltip-date">${formatDate(date)}</div>
      <div class="tooltip-summary">
        <span class="tooltip-dot ${impact}"></span>
        <span>${impactSummary[impact]}</span>
        ${duration ? `<span class="tooltip-duration">${duration}</span>` : ''}
      </div>
      ${incidents.length ? '<div class="tooltip-related">Reported incidents</div>' : ''}
      ${incList}
    `;
    tooltip.classList.add('active');
    tooltip.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => positionTooltip(target));
  };

  const hideTooltip = () => {
    tooltip.classList.remove('active');
    tooltip.setAttribute('aria-hidden', 'true');
    container.classList.remove('tooltip-open');
    const panel = container.closest('.panel');
    if (panel) panel.style.zIndex = '';
  };

  const scheduleHide = () => {
    if (state.hideTimeout) window.clearTimeout(state.hideTimeout);
    state.hideTimeout = window.setTimeout(hideTooltip, 120);
  };

  bars.querySelectorAll('span').forEach((bar) => {
    if (bar.dataset.dayIndex === undefined) return;
    bar.addEventListener('mouseenter', () => showTooltip(bar));
    bar.addEventListener('focus', () => showTooltip(bar));
    bar.addEventListener('mouseleave', scheduleHide);
    bar.addEventListener('blur', scheduleHide);
  });

  if (!tooltip.dataset.bound) {
    tooltip.addEventListener('mouseenter', () => { if (state.hideTimeout) window.clearTimeout(state.hideTimeout); });
    tooltip.addEventListener('mouseleave', scheduleHide);
    tooltip.dataset.bound = 'true';
  }
};

/* =========================================================
   INIT
   ========================================================= */

// Time toggle
document.querySelectorAll('.time-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.time-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentWindow = btn.dataset.window;
    closeDetailPanel();
    if (cachedProbeData) renderWithWindow(currentWindow);
  });
});

Promise.all([
  renderProbeData().catch(console.error),
  renderIncidents().catch(console.error),
]);
