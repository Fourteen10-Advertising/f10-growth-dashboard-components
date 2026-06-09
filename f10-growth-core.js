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
