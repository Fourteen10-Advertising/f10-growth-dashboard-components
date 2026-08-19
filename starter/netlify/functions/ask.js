/**
 * Netlify Function: Ask (AI explorer)  — PRD US-006/US-007
 *
 * A per-site sibling of bq.js. It takes a free-text question and returns a typed
 * viz spec grounded in a real BigQuery result. The hybrid pipeline tries the
 * curated semantic model first and only falls back to guarded text-to-SQL for the
 * long tail. Every query is dry-run and checked against the client's dataset
 * allowlist before it runs, and executes under the client's scoped service
 * account, so it can never read another client's data.
 *
 * Everything sensitive stays server-side: the browser never sees the service
 * account, the access token, or a raw model prompt. It only ever receives a viz
 * spec plus a plain-English interpretation, date range and row count.
 *
 * Per-site setup:
 *   - Copy this client's semantic model to  netlify/functions/semantic-model.json
 *     (from the framework's ask/models/<client>.json).
 *   - Set GOOGLE_SERVICE_ACCOUNT to the client's SCOPED service account JSON.
 *   - Optional env: BQ_PROJECT_ID (default mcc-poc-477801),
 *     ASK_GEMINI_MODEL (default gemini-3.6-flash), ASK_GEMINI_LOCATION (default global),
 *     ASK_LOCATION (default australia-southeast1),
 *     ALLOWED_ORIGIN (CORS lock, same as bq.js).
 */

'use strict';

const bq = require('./ask-lib/bq-client.js');
const gemini = require('./ask-lib/gemini.js');
const { runAsk } = require('./ask-lib/pipeline.js');
const { TtlCache, keyFor } = require('./ask-lib/cache.js');
const { SlidingWindow, clientKey } = require('./ask-lib/ratelimit.js');
const { makeLogger } = require('./ask-lib/log.js');

const PROJECT = process.env.BQ_PROJECT_ID || 'mcc-poc-477801';
const LOCATION = process.env.ASK_LOCATION || 'australia-southeast1'; // BigQuery data location (stays in AU)
// Gemini can run in a different location than BigQuery. 'global' unlocks newer
// models (e.g. gemini-3.6-flash) not offered in australia-southeast1. Note: with a
// non-AU Gemini location, the prompt and any sample rows leave the AU region.
const GEMINI_LOCATION = process.env.ASK_GEMINI_LOCATION || 'global';
const GEMINI_MODEL = process.env.ASK_GEMINI_MODEL || 'gemini-3.6-flash';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const LOG_TABLE = process.env.ASK_LOG_TABLE || ''; // e.g. dashboard_ops.dashboard_ai_log

// Per-instance singletons (survive across warm invocations).
const CACHE = new TtlCache(Number(process.env.ASK_CACHE_TTL_MS || 60000), 200);
const LIMITER = new SlidingWindow(Number(process.env.ASK_RATE_LIMIT || 30), Number(process.env.ASK_RATE_WINDOW_MS || 60000));

let MODEL = null;
try { MODEL = require('./semantic-model.json'); } catch { MODEL = null; }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...cors(event), 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors(event), body: 'Method not allowed' };

  if (!MODEL) return json(event, 501, { error: 'The Ask feature is not configured for this site.' });

  try {
    const { question, dateRange } = JSON.parse(event.body || '{}');
    // The dashboard's selected date range, used when the question does not name its own.
    const iso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const defaultDateRange = (dateRange && iso(dateRange.start) && iso(dateRange.end))
      ? { start: dateRange.start, end: dateRange.end } : null;

    // Per-site rate limit (US-008): reject abusive volumes with a clear message.
    const rl = LIMITER.check(clientKey(event));
    if (!rl.allowed) {
      return { statusCode: 429, headers: { ...cors(event), 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) },
        body: JSON.stringify({ error: 'Too many questions right now. Please wait a moment and try again.' }) };
    }

    // Cache identical questions within the window so they are not re-billed (US-008).
    // The key includes the selected range so changing the date picker returns a fresh answer.
    const today = new Date().toISOString().slice(0, 10);
    const rangeKey = defaultDateRange ? `${defaultDateRange.start}_${defaultDateRange.end}` : 'default';
    const cacheKey = keyFor(question || '', today) + '::' + rangeKey;
    const cached = CACHE.get(cacheKey);
    if (cached) return json(event, 200, { ...cached, cached: true });

    const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT;
    if (!saRaw) throw new Error('GOOGLE_SERVICE_ACCOUNT is not set');
    const sa = JSON.parse(saRaw);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');

    // One cloud-platform token per request, used for BigQuery (IAM still limits
    // it to the scoped SA's dataViewer/jobUser) and for Vertex AI Gemini.
    const token = await bq.getAccessToken(sa, gemini.CLOUD_PLATFORM_SCOPE);

    const clients = {
      dryRun: (sql) => bq.dryRun(PROJECT, token, sql, LOCATION),
      runQuery: (sql, opts) => bq.runQuery(PROJECT, token, sql, { location: LOCATION, ...opts }),
      parseRows: bq.parseRows,
      geminiSpec: async (q) => gemini.parseJson(await gemini.generate(token, {
        project: PROJECT, location: GEMINI_LOCATION, model: GEMINI_MODEL,
        system: gemini.buildSpecSystemPrompt(MODEL, today), prompt: q, json: true,
      })),
      geminiFallback: async (q) => gemini.parseJson(await gemini.generate(token, {
        project: PROJECT, location: GEMINI_LOCATION, model: GEMINI_MODEL,
        system: gemini.buildFallbackSqlSystemPrompt(MODEL, { today, defaultRange: defaultDateRange }), prompt: q, json: true,
      })),
      geminiFix: async (q, badSql, errorMsg) => gemini.parseJson(await gemini.generate(token, {
        project: PROJECT, location: GEMINI_LOCATION, model: GEMINI_MODEL,
        system: gemini.buildFallbackSqlSystemPrompt(MODEL, { today, defaultRange: defaultDateRange }),
        prompt: gemini.buildFixSqlPrompt(q, badSql, errorMsg), json: true,
      })),
      geminiInterpret: async (q, vizSpec, rows) => gemini.generate(token, {
        project: PROJECT, location: GEMINI_LOCATION, model: GEMINI_MODEL,
        system: 'You are a marketing analyst writing a short, plain interpretation for a client.',
        prompt: gemini.buildInterpretationPrompt(q, vizSpec, rows), json: false,
      }),
    };

    // Every ask writes a log row (client, question, path, sql, bytes, rows,
    // latency, outcome, ts) so demand can be mined; no-op if ASK_LOG_TABLE unset.
    const logger = makeLogger({ project: PROJECT, token, table: LOG_TABLE, client: MODEL.client });
    const { vizSpec, meta } = await runAsk({ model: MODEL, question, today, clients, logger, defaultDateRange });

    // The browser gets the viz spec plus the request-to-dashboard essentials
    // (validated SQL and path). The SQL is read-only and dataset-scoped; the
    // issue function (US-010) re-validates any SQL it is handed.
    const payload = {
      vizSpec,
      request: { sql: meta.sql, path: meta.path, dateRange: meta.dateRange, rowCount: meta.rowCount },
    };
    CACHE.set(cacheKey, payload);
    return json(event, 200, payload);
  } catch (err) {
    // Guard refusals (unsafe SQL / out-of-scope table) are safe 4xx, not 500.
    let status = (err && err.status) || 0;
    if (!status && err && (err.code === 'UNSAFE_SQL' || err.code === 'OUT_OF_SCOPE_TABLE')) status = 400;
    if (!status) status = 500;
    // Log the message plus any underlying cause (e.g. the BigQuery dry-run error).
    console.error('[ask] error:', err && err.message ? err.message : err, err && err.cause ? '| cause: ' + err.cause : '');
    // 4xx and the deliberate 503 (model unavailable) carry a safe, useful reason;
    // other 5xx stay generic.
    const message = ((status >= 400 && status < 500) || status === 503)
      ? (err.message || 'This question could not be answered.')
      : 'Something went wrong answering that question.';
    return json(event, status, { error: message });
  }
};

function json(event, statusCode, obj) { return { statusCode, headers: cors(event), body: JSON.stringify(obj) }; }

function cors(event) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  const origin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || '';
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) { headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN; headers['Vary'] = 'Origin'; }
  return headers;
}
