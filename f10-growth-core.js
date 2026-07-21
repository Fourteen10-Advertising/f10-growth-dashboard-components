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

/* ── Table builder ──
 * headers: [{ label, num }]  rows: array of arrays of cell HTML/strings. */
function buildTable(containerId, headers, rows){
  const el = document.getElementById(containerId);
  if(!el) return;
  if(!rows || !rows.length){ el.innerHTML = '<p class="no-data">No data for this period.</p>'; return; }
  const ths = headers.map(h => `<th class="${h.num ? 'num' : ''}">${h.label}</th>`).join('');
  const trs = rows.map(r => `<tr>${r.map((cell, i) => `<td class="${headers[i] && headers[i].num ? 'num' : ''}">${cell == null ? '—' : cell}</td>`).join('')}</tr>`).join('');
  el.innerHTML = `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
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
