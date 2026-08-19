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
  let path = null, spec = null, built = null, sql = null, fallbackViz = null;

  // Skip the fixed curated matcher when the question names its own time period
  // ("last 6 months"), so the range-aware model path handles it. Also skip a
  // matched question that has no grain when the user clearly wants a time series
  // ("by week", "over time"), so it becomes a proper breakdown-over-time.
  let det = null;
  if (!resolve.hasExplicitDateRange(question)) {
    const cand = resolve.resolveQuestion(model, question);
    if (cand && !(resolve.wantsTimeSeries(question) && !(cand.spec && cand.spec.grain))) det = cand;
  }
  if (det) { path = 'curated-deterministic'; spec = det.spec; }

  // Track a model/infra failure separately from "the model had no answer", so a
  // broken model (e.g. a bad model id) surfaces loudly instead of masquerading as
  // "cannot answer" on every question.
  let modelError = null;
  if (!spec && clients.geminiSpec) {
    try {
      const mapped = await clients.geminiSpec(question);
      if (mapped && mapped.curated && mapped.spec) {
        try { resolve.buildQuery(model, mapped.spec, { today }); spec = mapped.spec; path = 'curated-gemini'; }
        catch { /* invalid spec -> fall through to text-to-SQL */ }
      }
    } catch (e) { modelError = e; }
  }

  if (spec) {
    // A curated spec with no explicit date range inherits the dashboard's selected
    // range (defaultDateRange). A question that named its own period already set it.
    if (!spec.dateRange && defaultDateRange) spec = { ...spec, dateRange: defaultDateRange };
    built = resolve.buildQuery(model, spec, { today });
    sql = built.sql;
  } else {
    if (!clients.geminiFallback) throw badRequest('question could not be answered from the semantic model');
    let fb = null;
    try { fb = await clients.geminiFallback(question); }
    catch (e) { modelError = e; }
    if (!fb || !fb.sql) {
      if (modelError) {
        // Infra problem (model unavailable/misconfigured): surface it, do not
        // pretend the question was unanswerable.
        const e = new Error('The AI model is unavailable right now. Please try again shortly.');
        e.status = 503; e.cause = modelError.message; throw e;
      }
      const e = new Error('I could not answer that from the available data. Try a simpler breakdown or a different question.');
      e.status = 422; throw e;
    }
    guard.assertSelectOnly(fb.sql);
    sql = guard.ensureLimit(fb.sql, maxRows);
    fallbackViz = fb.viz || null; // the model's chart descriptor for this result
    path = 'fallback-sql';
  }

  // ── 3. The single gate: dry-run, allowlist, bytes cap ──
  // A dry-run failure means the query is invalid against the schema. For a
  // model-generated fallback we give the model one chance to fix it from the
  // error (self-repair). If it still fails, that is a clean "can't answer", not a
  // server error.
  let dry;
  try {
    dry = await clients.dryRun(sql);
  } catch (e1) {
    let repaired = false;
    if (path === 'fallback-sql' && clients.geminiFix) {
      let fixed = null;
      try { fixed = await clients.geminiFix(question, sql, e1.message); } catch { /* ignore */ }
      if (fixed && fixed.sql) {
        try {
          guard.assertSelectOnly(fixed.sql);
          const fixedSql = guard.ensureLimit(fixed.sql, maxRows);
          dry = await clients.dryRun(fixedSql);
          sql = fixedSql; if (fixed.viz) fallbackViz = fixed.viz; path = 'fallback-sql-repaired'; repaired = true;
        } catch { /* repair failed -> fall through to clean 422 */ }
      }
    }
    if (!repaired) {
      const err = new Error('I could not answer that from the available data. Try a simpler breakdown or a different question.');
      err.status = 422;
      err.cause = e1 && e1.message;
      throw err;
    }
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
  // Curated path: typed viz from the spec. Fallback path: the model's chart
  // descriptor (so it can pivot/line like curated), else a generic table.
  const fbTitle = String(question).trim().slice(0, 90);
  let vizSpec = built
    ? resolve.buildVizSpec(model, spec, built, rows)
    : (resolve.buildFallbackViz(fallbackViz, rows, { title: fbTitle, dateRange: defaultDateRange || null })
       || buildGenericVizSpec(rows, { title: fbTitle, dateRange: defaultDateRange || null }));

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
