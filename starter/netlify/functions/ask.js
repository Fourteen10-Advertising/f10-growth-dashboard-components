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
 *     ASK_GEMINI_MODEL (default gemini-2.5-flash),
 *     ASK_LOCATION (default australia-southeast1),
 *     ALLOWED_ORIGIN (CORS lock, same as bq.js).
 */

'use strict';

const bq = require('./ask-lib/bq-client.js');
const gemini = require('./ask-lib/gemini.js');
const { runAsk } = require('./ask-lib/pipeline.js');

const PROJECT = process.env.BQ_PROJECT_ID || 'mcc-poc-477801';
const LOCATION = process.env.ASK_LOCATION || 'australia-southeast1';
const GEMINI_MODEL = process.env.ASK_GEMINI_MODEL || 'gemini-2.5-flash';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

let MODEL = null;
try { MODEL = require('./semantic-model.json'); } catch { MODEL = null; }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...cors(event), 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors(event), body: 'Method not allowed' };

  if (!MODEL) return json(event, 501, { error: 'The Ask feature is not configured for this site.' });

  try {
    const { question } = JSON.parse(event.body || '{}');

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
        project: PROJECT, location: LOCATION, model: GEMINI_MODEL,
        system: gemini.buildSpecSystemPrompt(MODEL), prompt: q, json: true,
      })),
      geminiFallbackSql: async (q) => gemini.generate(token, {
        project: PROJECT, location: LOCATION, model: GEMINI_MODEL,
        system: gemini.buildFallbackSqlSystemPrompt(MODEL), prompt: q, json: false,
      }),
      geminiInterpret: async (q, vizSpec, rows) => gemini.generate(token, {
        project: PROJECT, location: LOCATION, model: GEMINI_MODEL,
        system: 'You are a marketing analyst writing a short, plain interpretation for a client.',
        prompt: gemini.buildInterpretationPrompt(q, vizSpec, rows), json: false,
      }),
    };

    const today = new Date().toISOString().slice(0, 10);
    const logger = makeLogger(sa, event);
    const { vizSpec, meta } = await runAsk({ model: MODEL, question, today, clients, logger });

    // The browser gets the viz spec plus the request-to-dashboard essentials
    // (validated SQL and path). The SQL is read-only and dataset-scoped; the
    // issue function (US-010) re-validates any SQL it is handed.
    return json(event, 200, {
      vizSpec,
      request: { sql: meta.sql, path: meta.path, dateRange: meta.dateRange, rowCount: meta.rowCount },
    });
  } catch (err) {
    const status = (err && err.status) || 500;
    console.error('[ask] error:', err && err.message ? err.message : err);
    // 4xx carry a safe, non-leaky reason; 5xx stay generic.
    const message = status >= 400 && status < 500
      ? (err.message || 'This question could not be answered.')
      : 'Something went wrong answering that question.';
    return json(event, status, { error: message });
  }
};

/* Logging + cost/rate controls are added by US-008; until then this is a no-op
 * hook so the pipeline shape is stable. */
function makeLogger(/* sa, event */) {
  return null;
}

function json(event, statusCode, obj) { return { statusCode, headers: cors(event), body: JSON.stringify(obj) }; }

function cors(event) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  const origin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || '';
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) { headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN; headers['Vary'] = 'Origin'; }
  return headers;
}
