/**
 * f10-growth-core.js — F10 Growth Dashboard shared toolkit
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-growth-dashboard-components@vX.Y.Z/f10-growth-core.js"></script>
 *
 * Provides the building blocks every growth dashboard shares: a BigQuery fetch
 * wrapper, formatters, date/period maths, a SQL escaper, and KPI/table/chart
 * builders. Load BEFORE f10-growth-shell.js. Chart.js must be loaded first for
 * makeChart() to work.
 *
 * Reads one optional global:
 *   BQ_FUNCTION — Netlify function path (default '/.netlify/functions/bq').
 */

/* ── BigQuery fetch ──
 * The Netlify proxy returns the raw BigQuery REST response ({ rows, schema }).
 * runQuery() parses it into an array of plain objects keyed by column name. */
function bqEndpoint(){ return (typeof BQ_FUNCTION !== 'undefined' && BQ_FUNCTION) ? BQ_FUNCTION : '/.netlify/functions/bq'; }

function parseBQ(data){
  if(!data || !data.rows || !data.schema) return [];
  const fields = data.schema.fields.map(f => f.name);
  return data.rows.map(row => {
    const obj = {};
    row.f.forEach((cell, i) => { obj[fields[i]] = (cell.v === null || cell.v === undefined) ? null : cell.v; });
    return obj;
  });
}

async function runQuery(query){
  const res = await fetch(bqEndpoint(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query })
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  if(!res.ok) throw new Error((data && data.error) || 'Query failed');
  return parseBQ(data);
}

/* ── SQL escaping ──
 * Escape a value for inlining inside single quotes. Always route client-built
 * filter values through this — never trust a raw string in SQL. */
function sqlStr(v){ return String(v).replace(/'/g, "''"); }
/* Returns the value only if it is a plain ISO date, else ''. */
function sqlDate(v){ const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; }

/* ── Numeric + format helpers ── */
function n(v){ const x = parseFloat(v); return isNaN(x) ? 0 : x; }
function fmt(v, dp = 0){ if(v === null || v === undefined || v === '') return '—'; const x = parseFloat(v); return isNaN(x) ? '—' : x.toLocaleString('en-AU', { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
function fmtAUD(v){ const x = parseFloat(v); if(!x || isNaN(x)) return '—'; if(x >= 1000000) return '$' + fmt(x / 1000000, 1) + 'M'; if(x >= 1000) return '$' + fmt(x / 1000, 1) + 'k'; return '$' + fmt(x, 0); }
function fmtAUDFull(v){ const x = parseFloat(v); if(isNaN(x) || x === 0) return '—'; return '$' + x.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtPct(v, dp = 1){ if(v === null || v === undefined || v === '') return '—'; const x = parseFloat(v); return isNaN(x) ? '—' : x.toFixed(dp) + '%'; }
function fmtK(v){ const x = parseFloat(v); if(isNaN(x)) return '—'; if(x >= 1000000) return fmt(x / 1000000, 1) + 'M'; if(x >= 1000) return fmt(x / 1000, 1) + 'k'; return fmt(x, 0); }
function pct(a, b){ const na = n(a), nb = n(b); if(!nb) return null; return (na / nb) * 100; }

/* Percentage-change badge. invert=true for cost metrics (lower is better). */
function chg(curr, prev, invert = false){
  const c = n(curr), p = n(prev);
  if(!p) return { cls: 'change-na', txt: 'N/A' };
  const d = ((c - p) / Math.abs(p)) * 100;
  const up = d >= 0;
  const good = invert ? !up : up;
  return { cls: good ? 'change-up' : 'change-down', txt: (up ? '+' : '') + d.toFixed(1) + '%' };
}

/* ── Date + period helpers ── */
function today(){ return new Date().toISOString().slice(0, 10); }
function daysAgo(d){ const dt = new Date(); dt.setDate(dt.getDate() - d); return dt.toISOString().slice(0, 10); }
function addDays(d, k){ const dt = new Date(d); dt.setDate(dt.getDate() + k); return dt.toISOString().slice(0, 10); }
function subYear(d){ const dt = new Date(d); dt.setFullYear(dt.getFullYear() - 1); return dt.toISOString().slice(0, 10); }
function diffDays(s, e){ return Math.round((new Date(e) - new Date(s)) / 86400000); }

/* Given a start/end, return the selected window plus its prior-year (py) and
 * prior-period (pp) equivalents — the comparison windows every growth dashboard needs. */
function computePeriods(s, e){
  const days = diffDays(s, e) + 1;
  const pyS = subYear(s), pyE = subYear(e);
  const ppE = addDays(s, -1), ppS = addDays(ppE, -(days - 1));
  return { s, e, days, pyS, pyE, ppS, ppE };
}

/* Format a single YYYY-MM-DD as "6 Jun", and a range as "6 Jun – 14 Jun".
   Used by the date-range trigger label, selection summary and presets. */
function fmtDay(d){ const dt = new Date(d + 'T00:00:00'); return dt.getDate() + ' ' + dt.toLocaleString('en-AU', { month: 'short' }); }
function fmtRange(s, e){ return fmtDay(s) + ' – ' + fmtDay(e); }

/* First and last day of the calendar month containing d (YYYY-MM-DD). Used by
   the date-range presets (This month / Last month). */
function startOfMonth(d){ const dt = new Date(d + 'T00:00:00'); return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-01'; }
function endOfMonth(d){ const dt = new Date(d + 'T00:00:00'); const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0); return last.getFullYear() + '-' + String(last.getMonth() + 1).padStart(2, '0') + '-' + String(last.getDate()).padStart(2, '0'); }

/* BigQuery DATE_TRUNC expression for a granularity ('day' | 'week' | 'month'). */
function gGroup(field, gran){
  if(gran === 'week')  return `DATE_TRUNC(${field}, WEEK(MONDAY))`;
  if(gran === 'month') return `DATE_TRUNC(${field}, MONTH)`;
  return field;
}

/* ── DOM + CSS helpers ── */
function getCSS(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

/* ── KPI card builder ──
 * value: preformatted string. Pass curr/prev to render a change indicator;
 * invert=true for cost metrics (lower = better). opts.highlight for the brand-accent card. */
function kpiCard(label, value, sub, curr, prev, invert = false, opts = {}){
  const change = (curr !== undefined && prev !== undefined) ? chg(curr, prev, invert) : null;
  return `<div class="kpi-card${opts.highlight ? ' highlight' : ''}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    ${change ? `<div class="kpi-change ${change.cls}">${change.txt}</div>` : ''}
  </div>`;
}

/* ── Sortable-table support ──
 * Sort state per table container, so a sort survives a redraw (filter/date
 * change) instead of snapping back. Keyed by container id.
 * { col: <index|null>, dir: 0 none | 1 asc | -1 desc } */
const _f10TableState = {};

/* The sortable value of a cell.
 * A cell's PRIMARY value is the text before any markup, so a value with a
 * decoration appended — e.g. `$1,234<div class="kpi-change">+5.7%</div>` — sorts
 * on `$1,234`, not on the delta. Numeric columns strip `$`, thousands commas, a
 * trailing `%`, and a trailing `x` (ROAS), and treat blank/`—` as empty so those
 * rows sort last in both directions. Non-numeric columns compare lower-cased text. */
function f10SortValue(cell, isNum){
  const raw = cell == null ? '' : String(cell);
  let txt = raw.split('<')[0];
  if(!txt.trim()) txt = raw.replace(/<[^>]*>/g, ' ');
  txt = txt.replace(/&nbsp;/g, ' ').trim();
  if(!isNum) return txt.toLowerCase();
  if(!txt || txt === '—' || txt === '-') return null;
  const v = parseFloat(txt.replace(/[$,\s]/g, '').replace(/%$/, '').replace(/x$/i, ''));
  return isNaN(v) ? null : v;
}

/* ── Table builder ──
 * headers: [{ label, num }]  rows: array of arrays of cell HTML/strings.
 * opts.sortable — set false to opt out of sorting (default on).
 *
 * Headers are clickable and cycle ascending → descending → original order.
 * Columns flagged `num: true` sort numerically, the rest alphabetically; ties and
 * empty cells keep their original relative order (stable), and empties sort last. */
function buildTable(containerId, headers, rows, opts = {}){
  const el = document.getElementById(containerId);
  if(!el) return;
  if(!rows || !rows.length){
    el.innerHTML = '<p class="no-data">No data for this period.</p>';
    delete _f10TableState[containerId];
    return;
  }

  const sortable = opts.sortable !== false;
  const st = _f10TableState[containerId] || (_f10TableState[containerId] = { col: null, dir: 0 });
  if(st.col != null && st.col >= headers.length){ st.col = null; st.dir = 0; }

  let view = rows;
  if(sortable && st.col != null && st.dir !== 0){
    const isNum = !!(headers[st.col] && headers[st.col].num);
    view = rows.map((r, i) => ({ r, i })).sort((a, b) => {
      const av = f10SortValue(a.r[st.col], isNum), bv = f10SortValue(b.r[st.col], isNum);
      const aEmpty = av === null || av === '', bEmpty = bv === null || bv === '';
      if(aEmpty && bEmpty) return a.i - b.i;
      if(aEmpty) return 1;
      if(bEmpty) return -1;
      const c = isNum ? (av - bv) : String(av).localeCompare(String(bv));
      return c === 0 ? a.i - b.i : (st.dir === 1 ? c : -c);
    }).map(x => x.r);
  }

  const ind = i => {
    if(!sortable) return '';
    const on = st.col === i && st.dir !== 0;
    return `<span class="sort-ind${on ? ' active' : ''}">${on ? (st.dir === 1 ? '▲' : '▼') : '↕'}</span>`;
  };
  const ths = headers.map((h, i) =>
    `<th class="${h.num ? 'num' : ''}${sortable ? ' sortable' : ''}"${sortable ? ` data-f10col="${i}"` : ''}>${h.label}${ind(i)}</th>`).join('');
  const trs = view.map(r => `<tr>${r.map((cell, i) => `<td class="${headers[i] && headers[i].num ? 'num' : ''}">${cell == null ? '—' : cell}</td>`).join('')}</tr>`).join('');
  el.innerHTML = `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;

  if(sortable){
    el.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const i = Number(th.getAttribute('data-f10col'));
        if(st.col === i){
          st.dir = st.dir === 0 ? 1 : (st.dir === 1 ? -1 : 0);
          if(st.dir === 0) st.col = null;
        } else { st.col = i; st.dir = 1; }
        buildTable(containerId, headers, rows, opts);
      });
    });
  }
}

/* ── Chart builder ──
 * Wraps Chart.js, destroying any prior chart bound to the same canvas id. */
const _f10Charts = {};
function makeChart(id, config){
  if(_f10Charts[id]) _f10Charts[id].destroy();
  const ctx = document.getElementById(id);
  if(!ctx || typeof Chart === 'undefined') return null;
  _f10Charts[id] = new Chart(ctx, config);
  return _f10Charts[id];
}

/* ── Combo trend chart ──
 * Multi-axis bars + lines in the F10 growth "trend" look. Bars sit on the left
 * $ axis; each line lands on an axis chosen by `axis`:
 *   'cur'  → left $ (yCur)                'cnt'  → right count (yCnt)
 *   'cost' → right $, dashed (yCost)      'cpl'  → separate right $, dashed
 *            (yCpl) for a metric that sits orders of magnitude below yCost and
 *            so needs its own scale.
 * A y-axis is created only when a series actually uses it, so dropping a metric
 * (see f10ToggleChart) also drops its axis and the chart stays readable.
 * series: [{ label, data, kind:'bar'|'line', axis, color }]
 * opts:   { moneyTick?, tooltip? } optional Chart.js overrides. */
function f10MoneyTick(v){
  const x = parseFloat(v);
  if(isNaN(x)) return '';
  if(Math.abs(x) >= 1000) return '$' + (x / 1000).toLocaleString('en-AU', { maximumFractionDigits: 1 }) + 'k';
  if(Math.abs(x) < 10 && x !== 0) return '$' + x.toFixed(2);
  return '$' + x.toLocaleString('en-AU', { maximumFractionDigits: 0 });
}

function f10ComboChart(canvasId, labels, series, opts = {}){
  const moneyTick = opts.moneyTick || f10MoneyTick;
  const axisId = s => s.axis === 'cnt' ? 'yCnt' : s.axis === 'cost' ? 'yCost' : s.axis === 'cpl' ? 'yCpl' : 'yCur';
  const datasets = series.map(s => s.kind === 'bar'
    ? { type: 'bar', label: s.label, data: s.data, backgroundColor: s.color, yAxisID: axisId(s), order: 2, borderRadius: 3 }
    : { type: 'line', label: s.label, data: s.data, borderColor: s.color, backgroundColor: s.color, yAxisID: axisId(s),
        tension: 0.3, pointRadius: 2.5, borderWidth: 2, borderDash: (s.axis === 'cost' || s.axis === 'cpl') ? [5, 4] : [], spanGaps: true, order: 1 });
  const scales = {
    x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45, autoSkip: true } },
    yCur: { position: 'left', beginAtZero: true, ticks: { callback: moneyTick, font: { size: 10 } } },
  };
  if(series.some(s => s.axis === 'cnt'))  scales.yCnt  = { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } };
  if(series.some(s => s.axis === 'cost')) scales.yCost = { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { callback: moneyTick, font: { size: 10 } } };
  // A metric an order of magnitude below yCost (e.g. CPL vs CPA) gets its own
  // right axis; with two $ axes on the right, tint each axis's ticks to match
  // its line so they can be told apart.
  if(series.some(s => s.axis === 'cpl')){
    scales.yCpl = { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { callback: moneyTick, font: { size: 10 }, color: (series.find(s => s.axis === 'cpl') || {}).color } };
    if(scales.yCost) scales.yCost.ticks.color = (series.find(s => s.axis === 'cost') || {}).color;
  }
  return makeChart(canvasId, {
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: opts.tooltip || { callbacks: { label: c => {
          const v = c.parsed.y;
          if(v === null || v === undefined) return c.dataset.label + ': —';
          if(/roas/i.test(c.dataset.label)) return c.dataset.label + ': ' + v.toFixed(2) + 'x';
          if(c.dataset.yAxisID === 'yCnt') return c.dataset.label + ': ' + fmt(v, v % 1 !== 0 ? 1 : 0);
          const dp = Math.abs(v) < 100 ? 2 : 0;
          return c.dataset.label + ': $' + v.toLocaleString('en-AU', { minimumFractionDigits: dp, maximumFractionDigits: dp });
        } } },
      },
      scales,
    },
  });
}

/* ── Combo trend chart with metric toggles ──
 * Same chart as f10ComboChart, plus a chip row (rendered into the element with
 * id `togglesId`) that lets the viewer show or hide individual metrics. A hidden
 * metric leaves the chart entirely — including its y-axis — so ONE chart can
 * carry several metrics without drawing them all at once. This is the F10 answer
 * to "don't ship a second, near-identical chart just to isolate one metric":
 * ship one chart and let the reader pick what they want to see.
 *
 * Toggle state is keyed by each series' `key` (falling back to `label`) and
 * persists across redraws, so re-calling this with fresh data — after a horizon
 * or filter change, say — keeps the viewer's chosen metrics selected.
 *
 * series: [{ key?, label, data, kind, axis, color, on=true, toggle=true }]
 *   on:false     → metric starts hidden
 *   toggle:false → metric is always shown and gets no chip (e.g. the spend bar)
 * opts: forwarded to f10ComboChart. */
const _f10ToggleState = {};
function f10ToggleChart(canvasId, togglesId, labels, series, opts = {}){
  const keyOf = s => s.key || s.label;
  const state = _f10ToggleState[canvasId] || (_f10ToggleState[canvasId] = {});
  series.forEach(s => { const k = keyOf(s); if(!(k in state)) state[k] = s.on !== false; });

  const draw = () => f10ComboChart(canvasId, labels, series.filter(s => s.toggle === false || state[keyOf(s)]), opts);

  const toggles = document.getElementById(togglesId);
  if(toggles){
    toggles.innerHTML = series.filter(s => s.toggle !== false).map(s => {
      const k = keyOf(s);
      return `<button type="button" data-k="${String(k).replace(/"/g, '&quot;')}"${state[k] ? ' class="active"' : ''}>`
        + `<span class="metric-dot" style="background:${s.color}"></span>${s.label}</button>`;
    }).join('');
    // Delegate on the container so the listener survives innerHTML rebuilds; bind once.
    if(!toggles._f10Bound){
      toggles.addEventListener('click', e => {
        const btn = e.target.closest('button[data-k]');
        if(!btn) return;
        const k = btn.dataset.k;
        state[k] = !state[k];
        btn.classList.toggle('active', state[k]);
        draw();
      });
      toggles._f10Bound = true;
    }
  }
  return draw();
}

// ── Budget pacing tab ─────────────────────────────────────────────────────────
// f10PacingTab(cfg) returns a tab object ({id,group,navLabel,title,sub,body,load})
// to spread into config.tabs. It shows month-to-date actuals vs the full-month
// target prorated by days elapsed — per platform and blended — with a status
// table and two stacked through-the-month charts (cumulative actual vs a dashed
// target-pace line). It reads a governed targets table plus the client's actuals
// mart, so it never touches the source sheet.
//
// cfg = {
//   id, group, navLabel, title, sub, dot,     // optional chrome (sensible defaults)
//   targetsTable,                             // '{project}.{client}_reporting.pacing_targets'
//   actuals: { table, dateField, channelField, spend, revenue },
//   platformMap,                              // { gads:'Google Ads', meta:'Meta', linkedin:'LinkedIn' }
//   revenueNote,                              // optional caveat appended to the info box
//   spendOnly,                                // hide revenue KPI/ROAS + revenue columns + revenue chart
//   hideInfoBox,                              // hide the explanatory info box (prorate note + revenueNote)
// }
const F10_PACE_BEHIND = 0.9, F10_PACE_AHEAD = 1.1;

function f10PaceStatus(pace, kind){
  if(pace === null || !isFinite(pace)) return { cls: 'badge-grey', label: '—' };
  if(pace < F10_PACE_BEHIND) return kind === 'spend'
    ? { cls: 'badge-blue', label: 'Under' } : { cls: 'badge-red', label: 'Behind' };
  if(pace > F10_PACE_AHEAD) return kind === 'spend'
    ? { cls: 'badge-orange', label: 'Over' } : { cls: 'badge-green', label: 'Ahead' };
  return { cls: 'badge-green', label: 'On track' };
}
function f10PaceBadge(pace, kind){ const s = f10PaceStatus(pace, kind); return `<span class="badge ${s.cls}">${s.label}</span>`; }
function f10PaceFmt(pace){ return (pace === null || !isFinite(pace)) ? '—' : Math.round(pace * 100) + '%'; }

// Through-the-month cumulative chart: blended actual (solid, stops at the latest
// data day) vs a straight target-pace line to the full-month target.
function f10PacingChart(canvasId, dim, latestDay, dailyByChannel, metric, target){
  const labels = Array.from({ length: dim }, (_, i) => String(i + 1));
  const dayTotal = new Array(dim).fill(0);
  Object.values(dailyByChannel).forEach(byDay => {
    Object.entries(byDay).forEach(([day, v]) => { const d = +day; if(d >= 1 && d <= dim) dayTotal[d-1] += n(v[metric]); });
  });
  let acc = 0;
  const cumulative = dayTotal.map((v, i) => { acc += v; return i < latestDay ? acc : null; });
  const paceLine = labels.map((_, i) => target * (i + 1) / dim);
  const ink = getCSS('--ink') || '#000', grey = getCSS('--grey') || '#727272';
  makeChart(canvasId, {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Actual (cumulative)', data: cumulative, borderColor: ink, backgroundColor: 'transparent', borderWidth: 2.5, pointRadius: 2, pointHoverRadius: 4, tension: 0.15, spanGaps: false },
      { label: 'Target pace', data: paceLine, borderColor: grey, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, tension: 0 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 8, padding: 10, font: { size: 10 } } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y === null ? '—' : fmtAUD(c.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { font: { size: 9 }, maxTicksLimit: 16 }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { font: { size: 10 }, callback: v => f10MoneyTick(v) } },
      },
    },
  });
}

function f10PacingTab(cfg){
  const id = cfg.id || 'pacing';
  const platformMap = cfg.platformMap || { gads: 'Google Ads', meta: 'Meta', linkedin: 'LinkedIn' };
  const a = cfg.actuals || {};
  const dateField = a.dateField || 'date_start';
  const channelField = a.channelField || 'channel';
  const spendCol = a.spend || 'spend';
  const revCol = a.revenue || 'revenue';
  // Optional group-level breakdown. When byGroup is set and the actuals table has a
  // group column (actuals.groupField), the status table nests group rows under each
  // platform with a platform subtotal, while KPIs and charts stay blended. Targets are
  // keyed by platform + group_name instead of summed to platform. Fully backward-
  // compatible: without byGroup the output is exactly the platform-level view.
  const byGroup = !!cfg.byGroup && !!a.groupField;
  const groupField = a.groupField;
  const PRETTY = { gads: 'Google Ads', meta: 'Meta', linkedin: 'LinkedIn', bing: 'Bing', tiktok: 'TikTok', reddit: 'Reddit' };
  const prettyPlat = ch => PRETTY[String(ch).toLowerCase()] || ch;
  // spendOnly: hide the revenue KPI + ROAS cards, the revenue table columns, and the
  // revenue chart (for lead-gen clients with no tracked revenue).
  const spendOnly = !!cfg.spendOnly;

  async function load(){
    const host = document.getElementById(id + '-body');
    if(!host) return;

    const targetsSQL = `SELECT FORMAT_DATE('%Y-%m-%d', month) AS month, platform, group_name, target_spend, target_revenue FROM \`${cfg.targetsTable}\``;
    const actualsSQL = byGroup ? `
      WITH latest AS (SELECT MAX(${dateField}) AS d FROM \`${a.table}\`)
      SELECT ${channelField} AS channel,
             ${groupField} AS grp,
             FORMAT_DATE('%Y-%m-%d', ${dateField}) AS date,
             CAST((SELECT d FROM latest) AS STRING) AS latest_date,
             ROUND(SUM(${spendCol}), 2) AS spend,
             ROUND(SUM(${revCol}), 2) AS revenue
      FROM \`${a.table}\`
      WHERE ${dateField} >= DATE_TRUNC((SELECT d FROM latest), MONTH)
        AND ${dateField} <= (SELECT d FROM latest)
      GROUP BY channel, grp, date` : `
      WITH latest AS (SELECT MAX(${dateField}) AS d FROM \`${a.table}\`)
      SELECT ${channelField} AS channel,
             FORMAT_DATE('%Y-%m-%d', ${dateField}) AS date,
             CAST((SELECT d FROM latest) AS STRING) AS latest_date,
             ROUND(SUM(${spendCol}), 2) AS spend,
             ROUND(SUM(${revCol}), 2) AS revenue
      FROM \`${a.table}\`
      WHERE ${dateField} >= DATE_TRUNC((SELECT d FROM latest), MONTH)
        AND ${dateField} <= (SELECT d FROM latest)
      GROUP BY channel, date`;

    const [targets, actuals] = await Promise.all([runQuery(targetsSQL), runQuery(actualsSQL)]);
    if(!actuals.length){ host.innerHTML = '<div class="info-box">No performance data available.</div>'; return; }

    const latest = actuals[0].latest_date;
    const currentMonth = startOfMonth(latest);
    const dim = new Date(Date.UTC(+latest.slice(0, 4), +latest.slice(5, 7), 0)).getUTCDate();
    const elapsed = +latest.slice(8, 10);
    const frac = dim ? elapsed / dim : 0;

    // Accumulate actuals. Key by channel (platform view) or channel||group (group
    // view). Charts sum every key, so they stay blended in both modes.
    const mtd = {}, daily = {};
    actuals.forEach(r => {
      const key = byGroup ? (r.channel + '||' + (r.grp == null ? '' : r.grp)) : r.channel;
      (mtd[key] = mtd[key] || { spend: 0, revenue: 0 });
      mtd[key].spend += n(r.spend); mtd[key].revenue += n(r.revenue);
      const day = +String(r.date).slice(8, 10);
      (daily[key] = daily[key] || {})[day] = { spend: n(r.spend), revenue: n(r.revenue) };
    });

    // This-month targets, keyed the same way. platformMap maps the targets' platform
    // code to the mart's channel value.
    const tgt = {};
    targets.filter(t => String(t.month).slice(0, 10) === currentMonth).forEach(t => {
      const ch = platformMap[String(t.platform).toLowerCase()];
      if(!ch) return;
      const key = byGroup ? (ch + '||' + (t.group_name == null ? '' : t.group_name)) : ch;
      (tgt[key] = tgt[key] || { spend: 0, revenue: 0 });
      tgt[key].spend += n(t.target_spend); tgt[key].revenue += n(t.target_revenue);
    });

    const zero = { spend: 0, revenue: 0 };
    const paceRow = (channel, act, tg) => {
      const es = tg.spend * frac, er = tg.revenue * frac;
      return { channel, a_spend: act.spend, t_spend: tg.spend, e_spend: es, p_spend: es ? act.spend / es : null,
               a_rev: act.revenue, t_rev: tg.revenue, e_rev: er, p_rev: er ? act.revenue / er : null };
    };
    const sumRows = (label, list) => paceRow(label,
      list.reduce((x, r) => ({ spend: x.spend + r.a_spend, revenue: x.revenue + r.a_rev }), { spend: 0, revenue: 0 }),
      list.reduce((x, r) => ({ spend: x.spend + r.t_spend, revenue: x.revenue + r.t_rev }), { spend: 0, revenue: 0 }));

    // displayRows entries: { row: paceRow, kind: 'group' | 'subtotal' }. leafRows feeds
    // the blended grand total (groups only, never subtotals — subtotals would double-count).
    let leafRows, displayRows;
    if(byGroup){
      const perPlatform = {};
      new Set([...Object.keys(tgt), ...Object.keys(mtd)]).forEach(key => {
        const idx = key.indexOf('||');
        const ch = key.slice(0, idx), grp = key.slice(idx + 2);
        (perPlatform[ch] = perPlatform[ch] || new Set()).add(grp);
      });
      leafRows = []; displayRows = [];
      Object.values(platformMap).forEach(ch => {
        const grps = perPlatform[ch];
        if(!grps) return;
        const platGroupRows = [];
        Array.from(grps).sort().forEach(grp => {
          const key = ch + '||' + grp;
          const t = tgt[key], m = mtd[key] || zero;
          if(!t && !(m.spend || m.revenue)) return;
          const r = paceRow(grp || '(none)', m, t || zero);
          platGroupRows.push(r); leafRows.push(r);
          displayRows.push({ row: r, kind: 'group' });
        });
        if(platGroupRows.length) displayRows.push({ row: sumRows(ch, platGroupRows), kind: 'subtotal' });
      });
      if(!leafRows.length){ host.innerHTML = `<div class="info-box">No targets found for this month. Add rows to the targets sheet.</div>`; return; }
    } else {
      leafRows = Object.values(platformMap)
        .filter(ch => tgt[ch] && (tgt[ch].spend || tgt[ch].revenue))
        .map(ch => paceRow(ch, mtd[ch] || zero, tgt[ch]));
      if(!leafRows.length){ host.innerHTML = `<div class="info-box">No targets found for this month. Add rows to the targets sheet.</div>`; return; }
      displayRows = leafRows.map(r => ({ row: r, kind: 'group' }));
    }

    const blended = sumRows('Blended', leafRows);

    const monthLabel = new Date(currentMonth + 'T00:00:00').toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
    const impliedRoas = blended.t_spend ? blended.t_rev / blended.t_spend : null;
    const actualRoas = blended.a_spend ? blended.a_rev / blended.a_spend : null;

    const kpis = [
      kpiCard('MTD Spend', fmtAUD(blended.a_spend), `target ${fmtAUD(blended.t_spend)} · pace ${f10PaceFmt(blended.p_spend)} ${f10PaceBadge(blended.p_spend, 'spend')}`),
      ...(spendOnly ? [] : [
        kpiCard('MTD Revenue', fmtAUD(blended.a_rev), `target ${fmtAUD(blended.t_rev)} · pace ${f10PaceFmt(blended.p_rev)} ${f10PaceBadge(blended.p_rev, 'revenue')}`),
        kpiCard('Blended ROAS', actualRoas ? actualRoas.toFixed(2) + 'x' : '—', `implied target ${impliedRoas ? impliedRoas.toFixed(2) + 'x' : '—'}`),
      ]),
    ].join('');

    const tableTitle = byGroup ? `Pacing by platform &amp; group — ${monthLabel}` : `Pacing by platform — ${monthLabel}`;
    host.innerHTML = `
      ${cfg.hideInfoBox ? '' : `<div class="info-box">Pacing for <strong>${monthLabel}</strong>, prorated to the latest data date (day ${elapsed} of ${dim}). Actuals are month-to-date; each full-month target is prorated by days elapsed. Over-pacing on spend is a caution, not a win.${cfg.revenueNote ? ' ' + cfg.revenueNote : ''}</div>`}
      <div class="kpi-grid">${kpis}</div>
      <div class="table-card"><div class="table-card-header">${tableTitle}</div><div class="table-wrap" id="${id}-table"></div></div>
      <div class="chart-card"><div class="chart-card-title">Spend — MTD cumulative vs target pace</div><div class="chart-wrap"><canvas id="${id}-chart-spend"></canvas></div></div>
      ${spendOnly ? '' : `<div class="chart-card"><div class="chart-card-title">Revenue — MTD cumulative vs target pace</div><div class="chart-wrap"><canvas id="${id}-chart-rev"></canvas></div></div>`}`;

    const headers = [
      { label: byGroup ? 'Platform / Group' : 'Platform' }, { label: 'MTD Spend', num: true }, { label: 'Spend Target', num: true },
      { label: 'Exp. to date', num: true }, { label: 'Spend Pace', num: true }, { label: 'Spend' },
      ...(spendOnly ? [] : [
        { label: 'MTD Revenue', num: true }, { label: 'Rev Target', num: true }, { label: 'Rev Pace', num: true }, { label: 'Revenue' },
      ]),
    ];
    const labelCell = (r, kind) => {
      if(!byGroup) return r.channel;                                        // unchanged default view
      if(kind === 'group') return `<span style="padding-left:16px">${r.channel}</span>`;
      return `<strong>${prettyPlat(r.channel)}</strong>`;                   // platform subtotal
    };
    const mkRow = (r, kind) => [
      labelCell(r, kind), fmtAUDFull(r.a_spend), fmtAUDFull(r.t_spend), fmtAUDFull(r.e_spend), f10PaceFmt(r.p_spend), f10PaceBadge(r.p_spend, 'spend'),
      ...(spendOnly ? [] : [
        fmtAUDFull(r.a_rev), fmtAUDFull(r.t_rev), f10PaceFmt(r.p_rev), f10PaceBadge(r.p_rev, 'revenue'),
      ]),
    ];
    const tableRows = [
      ...displayRows.map(d => mkRow(d.row, d.kind)),
      mkRow(byGroup ? { ...blended, channel: 'Blended' } : blended, 'blended'),
    ];
    buildTable(id + '-table', headers, tableRows);

    f10PacingChart(id + '-chart-spend', dim, elapsed, daily, 'spend', blended.t_spend);
    if(!spendOnly) f10PacingChart(id + '-chart-rev', dim, elapsed, daily, 'revenue', blended.t_rev);
  }

  return {
    id,
    group: cfg.group || 'Pacing',
    navLabel: cfg.navLabel || 'Pacing',
    dot: cfg.dot || '#4b000f',
    title: cfg.title || 'Pacing — this month',
    sub: cfg.sub || 'Actuals vs target, prorated to date',
    body: `<div id="${id}-body"></div>`,
    load,
  };
}

// ── Ask tab (AI explorer) ─────────────────────────────────────────────────────
// f10AskTab(cfg) returns a tab object to spread into config.tabs. It renders a
// question box and shows the answer that the server-side 'ask' Netlify function
// returns as a typed viz spec, drawn ONLY through the shared builders (kpiCard,
// buildTable, makeChart, f10ComboChart) so answers look like the rest of the
// dashboard. The model, the prompt and the SQL all live server-side; this
// component never builds SQL and never sees a service account.
//
// cfg = {
//   id, group, navLabel, title, sub, dot,   // optional chrome (sensible defaults)
//   askFunction,       // default '/.netlify/functions/ask'
//   requestFunction,   // optional; when set, shows "Add to my dashboard" (US-010)
//   client,            // client slug, tagged on analytics events
//   suggestions,       // optional array of example questions rendered as chips
// }
const F10_ASK_PALETTE = ['#4b000f', '#fa023c', '#c8a500', '#3a8a2a', '#1565c0', '#8a1538', '#5e35b1', '#00838f'];

function f10AskEscape(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Format a raw value using the viz-spec column/series format, reusing the shared
// formatters so numbers match the rest of the dashboard.
function f10AskFormat(value, format){
  if(format === 'money') return fmtAUDFull(value);
  if(format === 'roas'){ const x = parseFloat(value); return isNaN(x) ? '—' : fmt(x, 2) + 'x'; }
  if(format === 'fraction') return fmtPct(n(value) * 100);
  if(format === 'pct') return fmtPct(value);
  if(format === 'count') return fmt(value);
  return f10AskEscape(value);
}

// Analytics facade (US-011). No-op if the shared F10A facade is not present.
function f10AskTrack(event, props){
  try { if(window.F10A && typeof F10A.track === 'function') F10A.track(event, props || {}); } catch(e){ /* analytics is best-effort */ }
}

// Render a returned viz spec into a host element, only via the shared builders.
function f10AskRenderResult(hostId, viz){
  const host = document.getElementById(hostId);
  if(!host) return;
  const t = viz.chartType;

  if(t === 'kpi'){
    const row = (viz.rows && viz.rows[0]) || {};
    const cards = (viz.columns || []).map(c => kpiCard(c.label, f10AskFormat(row[c.key], c.format))).join('');
    host.innerHTML = `<div class="kpi-grid">${cards || '<div class="no-data">No data for this question.</div>'}</div>`;
    return;
  }

  if(t === 'table'){
    const tid = hostId + '-tbl';
    host.innerHTML = `<div class="table-card"><div class="table-card-header">${f10AskEscape(viz.title || 'Result')}</div><div class="table-wrap" id="${tid}"></div></div>`;
    const headers = (viz.columns || []).map(c => ({ label: c.label, num: !!c.num }));
    const rows = (viz.rows || []).map(r => (viz.columns || []).map(c => f10AskFormat(r[c.key], c.format)));
    buildTable(tid, headers, rows);
    return;
  }

  if(t === 'pivot'){
    // Breakdown over time: one line per dimension value across the buckets, for one metric.
    const cid = hostId + '-cnv';
    host.innerHTML = `<div class="chart-card"><div class="chart-card-title">${f10AskEscape(viz.title || 'Result')}</div><div class="chart-wrap"><canvas id="${cid}"></canvas></div></div>`;
    const xKey = viz.x.key, pKey = viz.pivot.key, mKey = viz.metric.key;
    const buckets = [...new Set((viz.rows || []).map(r => r[xKey]))].sort();
    const groups = [...new Set((viz.rows || []).map(r => r[pKey]))];
    const byKey = new Map((viz.rows || []).map(r => [r[xKey] + '|' + r[pKey], r]));
    const datasets = groups.map((g, i) => ({
      label: g == null ? '—' : String(g),
      data: buckets.map(b => { const r = byKey.get(b + '|' + g); return r ? n(r[mKey]) : null; }),
      borderColor: F10_ASK_PALETTE[i % F10_ASK_PALETTE.length],
      backgroundColor: F10_ASK_PALETTE[i % F10_ASK_PALETTE.length],
      tension: 0.25, fill: false, spanGaps: true,
    }));
    makeChart(cid, {
      type: 'line',
      data: { labels: buckets, datasets },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'bottom' } } },
    });
    return;
  }

  // line | bar | combo
  const cid = hostId + '-cnv';
  host.innerHTML = `<div class="chart-card"><div class="chart-card-title">${f10AskEscape(viz.title || 'Result')}</div><div class="chart-wrap"><canvas id="${cid}"></canvas></div></div>`;
  const labels = (viz.rows || []).map(r => r[viz.x.key]);
  const series = (viz.series || []).map((s, i) => ({
    label: s.label, data: (viz.rows || []).map(r => n(r[s.key])),
    kind: s.kind === 'bar' ? 'bar' : 'line', axis: s.axis || 'cur', color: F10_ASK_PALETTE[i % F10_ASK_PALETTE.length],
  }));
  if(t === 'combo'){ f10ComboChart(cid, labels, series, {}); return; }
  makeChart(cid, {
    type: t === 'bar' ? 'bar' : 'line',
    data: { labels, datasets: series.map(s => ({ label: s.label, data: s.data, borderColor: s.color, backgroundColor: s.color, tension: 0.25, fill: false, spanGaps: true })) },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: series.length > 1, position: 'bottom' } } },
  });
}

function f10AskTab(cfg){
  const id = cfg.id || 'ask';
  const endpoint = cfg.askFunction || '/.netlify/functions/ask';
  const suggestions = cfg.suggestions || [];
  // Latest dashboard context (updated on every load), so a submit uses the
  // currently-selected date range unless the question names its own period.
  let askCtx = null;

  const chips = suggestions.map(s => `<button type="button" class="ask-chip" data-q="${f10AskEscape(s)}">${f10AskEscape(s)}</button>`).join('');
  const body = `
    <div class="ask-wrap">
      <div class="ask-input-row">
        <input id="${id}-q" class="ask-input" type="text" autocomplete="off" placeholder="Ask a question about your data, e.g. spend by platform last month" />
        <button id="${id}-go" class="ask-btn" type="button">Ask</button>
      </div>
      ${chips ? `<div id="${id}-suggestions" class="ask-suggestions">${chips}</div>` : ''}
      <div id="${id}-status" class="ask-status" role="status" aria-live="polite"></div>
      <div id="${id}-meta" class="ask-meta"></div>
      <div id="${id}-result" class="ask-result"></div>
      <div id="${id}-actions" class="ask-actions"></div>
    </div>`;

  async function submit(question){
    question = (question || '').trim();
    if(!question) return;
    const statusEl = document.getElementById(id + '-status');
    const metaEl = document.getElementById(id + '-meta');
    const resultEl = document.getElementById(id + '-result');
    const actionsEl = document.getElementById(id + '-actions');
    metaEl.innerHTML = ''; resultEl.innerHTML = ''; actionsEl.innerHTML = '';
    statusEl.className = 'ask-status loading';
    statusEl.textContent = 'Thinking...';
    f10AskTrack('ask.submitted', { client: cfg.client, question });

    let data;
    try {
      const dateRange = (askCtx && askCtx.dates) ? { start: askCtx.dates.s, end: askCtx.dates.e } : undefined;
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, dateRange }) });
      try { data = await res.json(); } catch { data = null; }
      if(!res.ok || !data || !data.vizSpec) throw new Error((data && data.error) || 'Could not answer that question.');
    } catch(err){
      statusEl.className = 'ask-status error';
      statusEl.textContent = (err && err.message) ? err.message : 'Something went wrong answering that question.';
      f10AskTrack('ask.error', { client: cfg.client, question, message: err && err.message });
      return;
    }

    statusEl.className = 'ask-status'; statusEl.textContent = '';
    const viz = data.vizSpec;
    f10AskRenderResult(id + '-result', viz);

    const dr = viz.dateRange ? `${viz.dateRange.start} to ${viz.dateRange.end}` : '';
    metaEl.innerHTML = `${viz.interpretation ? `<div class="ask-interpretation"></div>` : ''}` +
      `<div class="ask-facts">${dr ? `<span>Period: ${f10AskEscape(dr)}</span>` : ''}<span>Rows: ${n(viz.rowCount)}</span></div>`;
    if(viz.interpretation){ const el = metaEl.querySelector('.ask-interpretation'); if(el) el.textContent = viz.interpretation; }
    f10AskTrack('ask.result_rendered', { client: cfg.client, question, chartType: viz.chartType, rowCount: n(viz.rowCount) });

    // "Add to my dashboard" — the server side is US-010; shown only when configured.
    if(cfg.requestFunction){
      actionsEl.innerHTML = `<button type="button" class="ask-request-btn" id="${id}-req">Add to my dashboard</button><span id="${id}-req-note" class="ask-req-note"></span>`;
      const reqBtn = document.getElementById(id + '-req');
      if(reqBtn) reqBtn.addEventListener('click', () => requestToDashboard(question, data));
    }
  }

  async function requestToDashboard(question, data){
    const note = document.getElementById(id + '-req-note');
    const btn = document.getElementById(id + '-req');
    if(btn) btn.disabled = true;
    if(note) note.textContent = 'Requesting...';
    f10AskTrack('ask.add_to_dashboard_requested', { client: cfg.client, question });
    try {
      const res = await fetch(cfg.requestFunction, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, sql: data.request && data.request.sql, vizSpec: data.vizSpec }),
      });
      const out = await res.json().catch(() => null);
      if(!res.ok || !out) throw new Error((out && out.error) || 'Request failed.');
      if(note) note.innerHTML = out.issueUrl
        ? `Requested — <a href="${f10AskEscape(out.issueUrl)}" target="_blank" rel="noopener">view request</a>`
        : 'Requested.';
    } catch(err){
      if(btn) btn.disabled = false;
      if(note) note.textContent = (err && err.message) ? err.message : 'Request failed.';
    }
  }

  // load() runs on every tab activation and whenever the date range, filters or
  // granularity change, so it refreshes askCtx each time. Listeners are bound once
  // (guarded) so repeated loads do not stack duplicate handlers.
  function load(ctx){
    askCtx = ctx;
    const input = document.getElementById(id + '-q');
    const go = document.getElementById(id + '-go');
    const sugg = document.getElementById(id + '-suggestions');
    if(go && !go._askBound){ go.addEventListener('click', () => submit(input ? input.value : '')); go._askBound = true; }
    if(input && !input._askBound){ input.addEventListener('keydown', (e) => { if(e.key === 'Enter') submit(input.value); }); input._askBound = true; }
    if(sugg && !sugg._askBound){
      sugg.addEventListener('click', (e) => {
        const chip = e.target.closest('.ask-chip'); if(!chip) return;
        const q = chip.getAttribute('data-q'); if(input) input.value = q; submit(q);
      });
      sugg._askBound = true;
    }
  }

  return {
    id,
    group: cfg.group || 'Ask',
    navLabel: cfg.navLabel || 'Ask',
    dot: cfg.dot || '#4b000f',
    title: cfg.title || 'Ask your data',
    sub: cfg.sub || 'Type a question and get a chart or table, built live from your data.',
    body,
    load,
  };
}
