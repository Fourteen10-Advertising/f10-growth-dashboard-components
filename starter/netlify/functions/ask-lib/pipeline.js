/**
 * pipeline.js — the hybrid Ask resolution pipeline (PRD US-006), with the query
 * guard (US-007) wired in at the single choke point every query passes through.
 *
 * Order of resolution:
 *   1. Curated, deterministic: the semantic model's own question matcher.
 *   2. Curated, model-assisted: Gemini maps the question onto a metric-spec that
 *      only uses the model's declared sources/metrics/dimensions.
 *   3. Guarded text-to-SQL fallback: Gemini writes a single SELECT over the
 *      model's tables; it is validated, force-LIMITed, dry-run, and its referenced
 *      tables are checked against the client's dataset allowlist before it runs.
 *
 * Every path ends at the same gate: dry-run, referenced-table allowlist check,
 * bytes cap, then execute. Clients (BigQuery + Gemini) are injected so this whole
 * flow is unit-tested with fakes and no network. The Netlify handler (ask.js)
 * injects the real clients.
 */

'use strict';

const resolve = require('./resolve.js');
const guard = require('./guard.js');

const MAX_QUESTION_LEN = 500;

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

/**
 * @param {object} args
 * @param {object} args.model      the client's semantic model
 * @param {string} args.question   the user's free-text question
 * @param {string} args.today      injected ISO date
 * @param {object} args.clients    { dryRun, runQuery, parseRows, geminiSpec, geminiFallbackSql, geminiInterpret }
 * @param {function} [args.logger] optional async (logRow) => void  (US-008)
 * @returns {Promise<{vizSpec, meta}>}
 */
async function runAsk({ model, question, today, clients, logger, defaultDateRange }) {
  const started = Date.now();
  if (typeof question !== 'string' || !question.trim()) throw badRequest('question is required');
  if (question.length > MAX_QUESTION_LEN) throw badRequest('question is too long');

  const maxRows = (model.limits && model.limits.maxRows) || guard.DEFAULT_MAX_ROWS;
  const maxBytes = Number((model.limits && model.limits.maxBytes) || guard.DEFAULT_MAX_BYTES);

  // ── 1/2. Resolve to either a curated spec (+ built SQL) or a fallback SQL ──
  let path = null, spec = null, built = null, sql = null;

  // Skip the fixed curated matcher when the question names its own time period,
  // so an explicit range ("last 6 months") reaches the range-aware model path.
  const det = resolve.hasExplicitDateRange(question) ? null : resolve.resolveQuestion(model, question);
  if (det) { path = 'curated-deterministic'; spec = det.spec; }

  if (!spec && clients.geminiSpec) {
    const mapped = await safe(() => clients.geminiSpec(question));
    if (mapped && mapped.curated && mapped.spec) {
      try { resolve.buildQuery(model, mapped.spec, { today }); spec = mapped.spec; path = 'curated-gemini'; }
      catch { /* invalid spec -> fall through to text-to-SQL */ }
    }
  }

  if (spec) {
    // A curated spec with no explicit date range inherits the dashboard's selected
    // range (defaultDateRange). A question that named its own period already set it.
    if (!spec.dateRange && defaultDateRange) spec = { ...spec, dateRange: defaultDateRange };
    built = resolve.buildQuery(model, spec, { today });
    sql = built.sql;
  } else {
    if (!clients.geminiFallbackSql) throw badRequest('question could not be answered from the semantic model');
    const raw = await safe(() => clients.geminiFallbackSql(question));
    if (!raw) { const e = new Error('cannot answer this question'); e.status = 422; throw e; }
    guard.assertSelectOnly(raw);
    sql = guard.ensureLimit(raw, maxRows);
    path = 'fallback-sql';
  }

  // ── 3. The single gate: dry-run, allowlist, bytes cap ──
  // A dry-run failure means the query is invalid against the schema (e.g. a
  // breakdown the data does not support, like age crossed with a column that
  // only exists on another table). That is a "can't answer", not a server error.
  let dry;
  try {
    dry = await clients.dryRun(sql);
  } catch (e) {
    const err = new Error('I could not answer that from the available data. Try a simpler breakdown or a different question.');
    err.status = 422;
    err.cause = e && e.message;
    throw err;
  }
  guard.assertReferencedTables(dry.referencedTables, model.datasets, model.project);
  const bytes = guard.checkBytes(dry.totalBytesProcessed, maxBytes);
  if (!bytes.ok) { const e = new Error('That query would scan too much data. Narrow the date range and try again.'); e.status = 413; throw e; }

  // ── execute ──
  let data;
  try {
    data = await clients.runQuery(sql, { maxBytes, maxResults: maxRows });
  } catch (e) {
    const err = new Error('I could not answer that from the available data. Try rephrasing the question.');
    err.status = 422;
    err.cause = e && e.message;
    throw err;
  }
  const rows = clients.parseRows(data);

  // ── viz spec ──
  let vizSpec = built
    ? resolve.buildVizSpec(model, spec, built, rows)
    : buildGenericVizSpec(rows, { title: 'Answer', dateRange: null });

  // ── grounded interpretation (Gemini; falls back to the deterministic one) ──
  if (clients.geminiInterpret) {
    const interp = await safe(() => clients.geminiInterpret(question, vizSpec, rows));
    if (interp) vizSpec = { ...vizSpec, interpretation: interp };
  }

  const meta = {
    path,
    sql,
    referencedTables: dry.referencedTables,
    bytesProcessed: dry.totalBytesProcessed,
    rowCount: rows.length,
    dateRange: vizSpec.dateRange || null,
    latencyMs: Date.now() - started,
    outcome: 'ok',
  };

  if (logger) await safe(() => logger({ question, ...meta }));
  return { vizSpec, meta };
}

/** Build a viz spec for the fallback path where there is no metric-spec. */
function buildGenericVizSpec(rows, { title, dateRange }) {
  const keys = rows && rows[0] ? Object.keys(rows[0]) : [];
  const columns = keys.map(k => {
    const numeric = rows.some(r => r[k] != null && !isNaN(parseFloat(r[k])) && String(r[k]).trim() !== '');
    return { label: prettyLabel(k), key: k, num: numeric, format: guessFormat(k, numeric) };
  });
  const chartType = rows.length <= 1 ? 'kpi' : 'table';
  return {
    chartType,
    source: null,
    title,
    dateRange,
    rowCount: rows.length,
    interpretation: rows.length ? `${rows.length} row(s) returned.` : 'No data for this question.',
    columns,
    rows: rows || [],
  };
}

function prettyLabel(k) { return String(k).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function guessFormat(k, numeric) {
  const key = String(k).toLowerCase();
  if (/spend|revenue|cost|cpa|cpc|cpm|value|profit/.test(key)) return 'money';
  if (/roas/.test(key)) return 'roas';
  if (/share|rate|pct|percent/.test(key)) return 'fraction';
  return numeric ? 'count' : 'text';
}

async function safe(fn) { try { return await fn(); } catch { return null; } }

module.exports = { runAsk, buildGenericVizSpec, MAX_QUESTION_LEN };
