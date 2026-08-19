/**
 * resolve.js — deterministic curated-metric resolver for the Ask tab.
 *
 * This is the "curated first" half of the hybrid Ask pipeline (PRD US-005/US-006).
 * It takes a metric-spec (a small, validated object describing a source, some
 * metrics, an optional dimension, a date range and filters) and deterministically
 * produces:
 *   - the exact BigQuery SQL to run (SELECT-only, always LIMITed), and
 *   - a viz spec the framework renders through its existing shared builders.
 *
 * The model file (e.g. ask/models/fastcover.json) is the source of truth for what
 * a client is allowed to ask about. Nothing here interpolates raw user text into
 * SQL: every table, column and metric fragment comes from the model, and the only
 * user-supplied values that reach SQL are filter values, which are escaped and
 * (where the model lists options) checked against the allowed set. That is what
 * makes the curated path safe by construction; the guarded text-to-SQL fallback
 * and its dry-run checks live in the ask function (US-006/US-007).
 *
 * CommonJS so the Netlify function can require it and a plain `node --test` file
 * can import it with no build step or dependencies.
 */

'use strict';

/* ── small helpers (mirrors of the browser toolkit, kept dependency-free) ── */

function sqlStr(v) { return String(v).replace(/'/g, "''"); }

function isIsoDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

function assertIso(s, what) {
  if (!isIsoDate(s)) throw new Error(`${what} must be an ISO date (YYYY-MM-DD), got: ${JSON.stringify(s)}`);
  return s;
}

// UTC-safe date arithmetic on YYYY-MM-DD strings.
function addDaysIso(iso, k) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
}
function startOfMonthIso(iso) { return iso.slice(0, 8) + '01'; }
function endOfMonthIso(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  const last = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this month
  return last.toISOString().slice(0, 10);
}
function subYearIso(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}
function subMonthsIso(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

/* Does the question ask for a time series (a breakdown over time)? Used to avoid
 * matching a curated question that has no grain when the user clearly wants one. */
function wantsTimeSeries(question) {
  const s = String(question || '').toLowerCase();
  return /\bover time\b/.test(s)
    || /\btrend(s|ing)?\b/.test(s)
    || /\b(daily|weekly|monthly|quarterly)\b/.test(s)
    || /\b(by|per|each|broken down by|split by)\s+(day|week|month|quarter)\b/.test(s);
}

/* Does the question itself name a time period? If so we let that drive the range
 * (via the model), rather than a curated default or the dashboard's picker. */
function hasExplicitDateRange(question) {
  const s = String(question || '').toLowerCase();
  return /(last|past|previous|trailing)\s+\d*\s*(day|week|month|quarter|year)s?/.test(s)
    || /\bthis\s+(week|month|quarter|year)\b/.test(s)
    || /\byear[-\s]?to[-\s]?date\b|\bytd\b/.test(s)
    || /\b(yesterday|today)\b/.test(s)
    || /\bq[1-4]\b/.test(s)
    || /\d{4}-\d{2}-\d{2}/.test(s)
    || /\bsince\s+\d{4}/.test(s)
    || /\b(in|during|for)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(s);
}

/* ── date range resolution ──
 * Accepts, in priority order:
 *   { start, end }            explicit ISO window
 *   { preset }                'today' | 'yesterday' | 'last_7_days' | 'last_28_days'
 *                             | 'last_30_days' | 'last_90_days' | 'this_month'
 *                             | 'last_month' | 'ytd'
 *   { lastDays: N }           trailing N days ending today
 * Defaults to the last 28 days. `today` is injected (ISO) so this is pure/testable. */
function resolveDateRange(dateRange, today) {
  const t = assertIso(today, 'today');
  const dr = dateRange || {};
  if (dr.start || dr.end) {
    return { start: assertIso(dr.start, 'dateRange.start'), end: assertIso(dr.end, 'dateRange.end') };
  }
  if (typeof dr.lastDays === 'number' && dr.lastDays > 0) {
    const days = Math.min(Math.floor(dr.lastDays), 730);
    return { start: addDaysIso(t, -(days - 1)), end: t };
  }
  if (typeof dr.lastMonths === 'number' && dr.lastMonths > 0) {
    return { start: subMonthsIso(t, Math.min(Math.floor(dr.lastMonths), 36)), end: t };
  }
  switch (dr.preset) {
    case 'today': return { start: t, end: t };
    case 'yesterday': { const y = addDaysIso(t, -1); return { start: y, end: y }; }
    case 'last_7_days': return { start: addDaysIso(t, -6), end: t };
    case 'last_30_days': return { start: addDaysIso(t, -29), end: t };
    case 'last_90_days': return { start: addDaysIso(t, -89), end: t };
    case 'last_3_months': return { start: subMonthsIso(t, 3), end: t };
    case 'last_6_months': return { start: subMonthsIso(t, 6), end: t };
    case 'last_12_months':
    case 'last_year': return { start: subMonthsIso(t, 12), end: t };
    case 'this_month': return { start: startOfMonthIso(t), end: t };
    case 'last_month': {
      const lastMonthEnd = addDaysIso(startOfMonthIso(t), -1);
      return { start: startOfMonthIso(lastMonthEnd), end: endOfMonthIso(lastMonthEnd) };
    }
    case 'ytd': return { start: t.slice(0, 4) + '-01-01', end: t };
    case 'last_28_days':
    default: return { start: addDaysIso(t, -27), end: t };
  }
}

// Prior-period and prior-year comparison windows (same helpers the dashboard uses).
function comparisonWindows(start, end) {
  const days = Math.round((new Date(end + 'T00:00:00Z') - new Date(start + 'T00:00:00Z')) / 86400000) + 1;
  const ppEnd = addDaysIso(start, -1);
  const ppStart = addDaysIso(ppEnd, -(days - 1));
  return { days, pyStart: subYearIso(start), pyEnd: subYearIso(end), ppStart, ppEnd };
}

function gGroup(field, grain) {
  if (grain === 'week') return `DATE_TRUNC(${field}, WEEK(MONDAY))`;
  if (grain === 'month') return `DATE_TRUNC(${field}, MONTH)`;
  return field;
}

/* ── model validation ── */

function validateModel(model) {
  const errors = [];
  if (!model || typeof model !== 'object') return ['model is not an object'];
  ['client', 'project', 'datasets', 'sources'].forEach(k => { if (!model[k]) errors.push(`missing ${k}`); });
  if (model.datasets && !Array.isArray(model.datasets)) errors.push('datasets must be an array');
  for (const [sid, src] of Object.entries(model.sources || {})) {
    if (!src.table) errors.push(`source ${sid}: missing table`);
    if (src.table && src.table.split('.').length !== 2) errors.push(`source ${sid}: table must be dataset.table`);
    if (src.table) {
      const ds = src.table.split('.')[0];
      if (model.datasets && !model.datasets.includes(ds)) errors.push(`source ${sid}: dataset ${ds} not in allowlist`);
    }
    if (!src.dateColumn) errors.push(`source ${sid}: missing dateColumn`);
    if (!src.metrics || !Object.keys(src.metrics).length) errors.push(`source ${sid}: no metrics`);
  }
  return errors;
}

/* ── the core builder: metric-spec → { sql, ... } ── */

function clampLimit(limit, model) {
  const max = (model.limits && model.limits.maxRows) || 1000;
  const def = (model.limits && model.limits.defaultRows) || 100;
  const raw = (typeof limit === 'number' && limit > 0) ? Math.floor(limit) : def;
  return Math.min(raw, max);
}

function filterClause(src, filter) {
  const dimId = filter.dimension;
  // A filter may target a declared dimension (plain column or curated `sql`
  // expression), or an explicit column (used by defaultFilters such as GA4
  // event_name). Only model-declared expressions ever reach SQL.
  let expr = null, options = null, isSql = false;
  if (src.dimensions && src.dimensions[dimId]) {
    const d = src.dimensions[dimId];
    expr = d.sql || d.column; options = d.options; isSql = !!d.sql;
  } else if (filter.column) { expr = filter.column; }
  if (!expr) throw new Error(`filter targets unknown dimension/column: ${JSON.stringify(dimId || filter.column)}`);
  if (!isSql && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) throw new Error(`illegal column identifier: ${expr}`);
  // A filter value may be a single value or an array (multi-select -> IN), so
  // "compare google and meta" becomes platform IN ('gads','meta'), not an
  // impossible platform='gads' AND platform='meta'.
  const values = Array.isArray(filter.value) ? filter.value : [filter.value];
  if (!values.length) throw new Error(`empty filter value for ${dimId}`);
  if (options && Array.isArray(options)) {
    for (const v of values) if (!options.includes(v)) throw new Error(`filter value "${v}" not allowed for ${dimId} (allowed: ${options.join(', ')})`);
  }
  if (values.length === 1) return `${expr} = '${sqlStr(values[0])}'`;
  return `${expr} IN (${values.map(v => `'${sqlStr(v)}'`).join(', ')})`;
}

/**
 * Build the BigQuery SQL for a validated metric-spec.
 * Returns { sql, referencedTables, start, end, metricIds, dimId, grain, source }.
 * Throws on anything not covered by the model (unknown source/metric/dimension).
 */
function buildQuery(model, spec, opts = {}) {
  if (!spec || !spec.source) throw new Error('spec.source is required');
  const src = model.sources[spec.source];
  if (!src) throw new Error(`unknown source: ${spec.source}`);

  const project = model.project;
  const dataset = src.table.split('.')[0];
  if (!model.datasets.includes(dataset)) throw new Error(`table ${src.table} not in dataset allowlist`);

  const today = opts.today || new Date().toISOString().slice(0, 10);
  const { start, end } = resolveDateRange(spec.dateRange, today);

  // metrics: default to all of the source's metrics when none named
  const metricIds = (spec.metrics && spec.metrics.length) ? spec.metrics : Object.keys(src.metrics);
  const selects = [];
  let groupBucket = null;
  if (spec.grain && spec.grain !== 'none' && spec.grain !== 'total') {
    if (src.grains && !src.grains.includes(spec.grain)) throw new Error(`grain ${spec.grain} not allowed for ${spec.source}`);
    groupBucket = gGroup(src.dateColumn, spec.grain);
    selects.push(`${groupBucket} AS bucket`);
  }
  let dimSelected = null;
  if (spec.dimension) {
    const dim = src.dimensions && src.dimensions[spec.dimension];
    if (!dim) throw new Error(`unknown dimension ${spec.dimension} for source ${spec.source}`);
    // A dimension is either a plain column or a curated SQL expression (e.g. an
    // age-band CASE). Plain columns are identifier-checked; curated `sql` is trusted.
    const dimExpr = dim.sql ? dim.sql : dim.column;
    if (!dim.sql && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(dim.column)) throw new Error(`illegal dimension column: ${dim.column}`);
    dimSelected = dim;
    selects.push(`${dimExpr} AS dim`);
  }
  metricIds.forEach(id => {
    const m = src.metrics[id];
    if (!m) throw new Error(`unknown metric ${id} for source ${spec.source}`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) throw new Error(`illegal metric id: ${id}`);
    selects.push(`${m.sql} AS ${id}`);
  });

  const where = [`${src.dateColumn} BETWEEN '${start}' AND '${end}'`];
  (src.defaultFilters || []).forEach(f => where.push(filterClause(src, f)));
  (spec.filters || []).forEach(f => where.push(filterClause(src, f)));

  const groupCols = [];
  if (groupBucket) groupCols.push('bucket');
  if (dimSelected) groupCols.push('dim');

  let sql = `SELECT ${selects.join(', ')}\nFROM \`${project}.${src.table}\`\nWHERE ${where.join(' AND ')}`;
  if (groupCols.length) sql += `\nGROUP BY ${groupCols.join(', ')}`;

  if (spec.orderBy && spec.orderBy.metric && metricIds.includes(spec.orderBy.metric)) {
    sql += `\nORDER BY ${spec.orderBy.metric} ${spec.orderBy.dir === 'asc' ? 'ASC' : 'DESC'}`;
  } else if (groupBucket) {
    sql += `\nORDER BY bucket`;
  } else if (dimSelected && metricIds.length) {
    sql += `\nORDER BY ${metricIds[0]} DESC`;
  }

  sql += `\nLIMIT ${clampLimit(spec.limit, model)}`;

  return {
    sql,
    referencedTables: [`${project}.${src.table}`],
    start, end,
    metricIds, dimId: spec.dimension || null, grain: (groupBucket ? spec.grain : null),
    source: spec.source,
  };
}

/* ── viz spec: what the framework renders through its shared builders ── */

function pickChartType(spec, ctx) {
  // A breakdown over time (dimension + grain) pivots the dimension into one line
  // per value across the time buckets. This is the "spend by age band over weeks"
  // shape; it takes precedence over an explicit viz that cannot express it.
  if (ctx.grain && ctx.dimId) return 'pivot';
  if (spec.viz) return spec.viz;
  if (ctx.grain) return 'combo';
  if (ctx.dimId) return 'table';
  return 'kpi';
}

function axisForFormat(fmt) {
  return (fmt === 'money') ? 'cur' : 'cnt';
}

function buildVizSpec(model, spec, ctx, rows) {
  const src = model.sources[spec.source];
  const chartType = pickChartType(spec, ctx);
  const metricCols = ctx.metricIds.map(id => {
    const m = src.metrics[id];
    return { label: m.label, key: id, format: m.format || 'count', invert: !!m.invert, note: m.note || null };
  });

  const base = {
    chartType,
    source: spec.source,
    title: buildTitle(model, spec, ctx),
    dateRange: { start: ctx.start, end: ctx.end },
    rowCount: rows ? rows.length : 0,
    interpretation: interpret(model, spec, ctx, rows),
    rows: rows || [],
  };

  if (chartType === 'pivot') {
    // One line per dimension value across the time buckets, for a single metric.
    const primary = metricCols[0];
    base.x = { key: 'bucket', label: grainLabel(ctx.grain) };
    base.pivot = { key: 'dim', label: src.dimensions[ctx.dimId].label };
    base.metric = { key: primary.key, label: primary.label, format: primary.format, invert: primary.invert };
  } else if (chartType === 'kpi') {
    base.columns = metricCols;
  } else if (chartType === 'table') {
    const cols = [];
    if (ctx.dimId) cols.push({ label: src.dimensions[ctx.dimId].label, key: 'dim', num: false, format: 'text' });
    metricCols.forEach(c => cols.push({ ...c, num: true }));
    base.columns = cols;
  } else { // line | bar | combo
    base.x = { key: ctx.grain ? 'bucket' : 'dim', label: ctx.grain ? grainLabel(ctx.grain) : (ctx.dimId ? src.dimensions[ctx.dimId].label : '') };
    base.series = metricCols.map((c, i) => ({
      label: c.label, key: c.key, format: c.format, invert: c.invert,
      kind: chartType === 'combo' ? (i === 0 ? 'bar' : 'line') : chartType,
      axis: c.invert && c.format === 'money' ? 'cost' : axisForFormat(c.format),
    }));
  }
  return base;
}

function grainLabel(g) { return g === 'week' ? 'Week' : g === 'month' ? 'Month' : 'Day'; }

/* Build a viz spec from the fallback's chart descriptor + result rows, so the
 * guarded text-to-SQL path can render proper charts (pivot/line/bar/combo),
 * not just a generic table. Returns null if the descriptor is unusable, so the
 * caller can fall back to a generic table. */
function buildFallbackViz(descriptor, rows, meta) {
  const d = descriptor;
  if (!d || !d.chartType) return null;
  const m = meta || {};
  const base = {
    source: null,
    title: m.title || 'Answer',
    dateRange: m.dateRange || null,
    rowCount: rows ? rows.length : 0,
    interpretation: (rows && rows.length) ? `${rows.length} row(s) returned.` : 'No data for this question.',
    rows: rows || [],
  };
  const ct = d.chartType;
  if (ct === 'pivot' && d.x && d.pivot && d.metric && d.metric.key) {
    return { ...base, chartType: 'pivot', x: d.x, pivot: d.pivot, metric: { key: d.metric.key, label: d.metric.label || d.metric.key, format: d.metric.format || 'count' } };
  }
  if ((ct === 'line' || ct === 'bar' || ct === 'combo') && d.x && Array.isArray(d.series) && d.series.length) {
    return {
      ...base, chartType: ct, x: d.x,
      series: d.series.map((s, i) => ({ label: s.label || s.key, key: s.key, format: s.format || 'count', kind: ct === 'combo' ? (i === 0 ? 'bar' : 'line') : ct, axis: s.format === 'money' ? 'cur' : 'cnt' })),
    };
  }
  if (ct === 'kpi' && Array.isArray(d.columns) && d.columns.length) {
    return { ...base, chartType: 'kpi', columns: d.columns.map(c => ({ label: c.label || c.key, key: c.key, format: c.format || 'count' })) };
  }
  if (ct === 'table' && Array.isArray(d.columns) && d.columns.length) {
    return { ...base, chartType: 'table', columns: d.columns.map(c => ({ label: c.label || c.key, key: c.key, format: c.format || 'text', num: !!c.num })) };
  }
  return null;
}

function buildTitle(model, spec, ctx) {
  const src = model.sources[spec.source];
  const parts = [];
  const primary = src.metrics[ctx.metricIds[0]];
  if (ctx.grain) parts.push(`${primary ? primary.label : 'Metrics'} by ${grainLabel(ctx.grain).toLowerCase()}`);
  else if (ctx.dimId) parts.push(`${src.label} by ${src.dimensions[ctx.dimId].label.toLowerCase()}`);
  else parts.push(`${src.label} headline`);
  parts.push(`${ctx.start} to ${ctx.end}`);
  return parts.join(', ');
}

/* Plain-English fallback interpretation. The ask function replaces this with
 * Gemini's grounded interpretation (US-006); it is kept here so the curated path
 * is self-sufficient and testable without a model call. */
function interpret(model, spec, ctx, rows) {
  const src = model.sources[spec.source];
  if (!rows || !rows.length) return `No ${src.label.toLowerCase()} data for ${ctx.start} to ${ctx.end}.`;
  const primary = ctx.metricIds[0];
  const label = src.metrics[primary] ? src.metrics[primary].label : primary;
  if (ctx.grain && ctx.dimId) {
    const groups = [...new Set(rows.map(r => r.dim))].length;
    return `${label} by ${src.dimensions[ctx.dimId].label.toLowerCase()} over ${grainLabel(ctx.grain).toLowerCase()}s (${groups} groups), ${ctx.start} to ${ctx.end}.`;
  }
  if (ctx.dimId && rows[0] && rows[0].dim != null) {
    const top = rows[0];
    return `Top ${src.dimensions[ctx.dimId].label.toLowerCase()} by ${label.toLowerCase()} for ${ctx.start} to ${ctx.end}: ${top.dim} (${formatValue(top[primary], src.metrics[primary].format)}).`;
  }
  if (ctx.grain) return `${label} across ${rows.length} ${grainLabel(ctx.grain).toLowerCase()}(s), ${ctx.start} to ${ctx.end}.`;
  const only = rows[0] || {};
  return `${label} for ${ctx.start} to ${ctx.end}: ${formatValue(only[primary], src.metrics[primary].format)}.`;
}

/* Server-side value formatter used only by the interpretation string. The browser
 * tab formats display values itself via the framework's fmt* helpers. */
function formatValue(v, fmt) {
  const num = parseFloat(v);
  if (isNaN(num)) return '—';
  if (fmt === 'money') return '$' + Math.round(num).toLocaleString('en-AU');
  if (fmt === 'roas') return num.toFixed(2) + 'x';
  if (fmt === 'fraction') return (num * 100).toFixed(1) + '%';
  if (fmt === 'pct') return num.toFixed(1) + '%';
  return num.toLocaleString('en-AU');
}

/* ── deterministic question matcher (curated backstop) ──
 * The primary NL→spec mapping is Gemini (US-006); this exact-phrase/keyword
 * matcher is the deterministic fallback and the thing the US-005 test exercises,
 * proving a representative question resolves to a curated metric-spec with no
 * free SQL. Returns { questionId, spec } or null on a miss. */
function resolveQuestion(model, question) {
  if (!question) return null;
  const q = String(question).toLowerCase().trim();
  let best = null;
  for (const entry of model.questions || []) {
    for (const phrase of entry.match || []) {
      const p = String(phrase).toLowerCase();
      if (q.includes(p)) {
        const score = p.length; // longer phrase match wins
        if (!best || score > best.score) best = { score, questionId: entry.id, spec: entry.spec };
      }
    }
  }
  return best ? { questionId: best.questionId, spec: best.spec } : null;
}

/** End-to-end curated resolution: question → spec → SQL + viz shell (no rows yet). */
function resolveCurated(model, question, opts = {}) {
  const hit = resolveQuestion(model, question);
  if (!hit) return null;
  const built = buildQuery(model, hit.spec, opts);
  return { questionId: hit.questionId, spec: hit.spec, ...built };
}

module.exports = {
  sqlStr, isIsoDate, addDaysIso, subMonthsIso, resolveDateRange, comparisonWindows, gGroup,
  hasExplicitDateRange, wantsTimeSeries,
  validateModel, clampLimit, filterClause, buildQuery,
  pickChartType, buildVizSpec, buildFallbackViz, buildTitle, interpret, formatValue,
  resolveQuestion, resolveCurated,
};
