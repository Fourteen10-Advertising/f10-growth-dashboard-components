/**
 * log.js — question logging to BigQuery (PRD US-008).
 *
 * Every ask writes one row to a dashboard_ai_log table: the client, the question,
 * the path taken (curated vs fallback), the final SQL, bytes billed, row count,
 * latency, outcome, error and timestamp. This log is the demand-sensing
 * instrument: the questions clients type are the roadmap for what to build into
 * the standing dashboard, and it is queryable to rank the most-asked questions
 * per client. Crucially it logs the FAILED questions too (outcome != 'ok') — an
 * unanswered question is a gap in the model, and those are the highest-value
 * signal for what to build next.
 *
 * The write uses BigQuery streaming inserts under the client's SA. The SA is a
 * data reader on the client's datasets and is granted insert on ONLY this one log
 * table (table-level IAM), so logging cannot widen its data access.
 *
 * Disabled (no-op) when ASK_LOG_TABLE is not set, so a site without the table
 * configured still works.
 *
 * Table schema (BigQuery):
 *   client STRING, question STRING, path STRING, sql STRING,
 *   bytes_billed INT64, row_count INT64, latency_ms INT64,
 *   outcome STRING, error STRING, ts TIMESTAMP
 * `outcome` is 'ok' on success, or a reason code on failure: 'cannot_answer',
 * 'too_much_data', 'model_unavailable', 'unsafe_sql', 'out_of_scope_table',
 * 'bad_request', 'error'. The insert sets ignoreUnknownValues, so a log table
 * created before the `error` column was added still records every other field.
 */

'use strict';

const bq = require('./bq-client.js');

const LOG_HOST = 'bigquery.googleapis.com';

/** Shape a pipeline meta object into a log row matching the table schema. */
function buildLogRow({ client, question, path, sql, bytesProcessed, rowCount, latencyMs, outcome, error, ts }) {
  return {
    client: client || null,
    question: String(question || '').slice(0, 2000),
    path: path || null,
    sql: sql ? String(sql).slice(0, 8000) : null,
    bytes_billed: Number(bytesProcessed || 0),
    row_count: Number(rowCount || 0),
    latency_ms: Number(latencyMs || 0),
    outcome: outcome || 'ok',
    error: error ? String(error).slice(0, 2000) : null,
    ts: ts || new Date().toISOString(),
  };
}

/** Streaming-insert a single row into project.dataset.table. */
async function insertLog(project, token, table, row) {
  const [dataset, tbl] = String(table).split('.');
  if (!dataset || !tbl) throw new Error(`ASK_LOG_TABLE must be dataset.table, got: ${table}`);
  // ignoreUnknownValues: a log table provisioned before the `error` column was
  // added still records every other field instead of rejecting the whole row.
  const body = JSON.stringify({ rows: [{ json: row }], ignoreUnknownValues: true });
  const res = await bq.request('POST', LOG_HOST,
    `/bigquery/v2/projects/${project}/datasets/${dataset}/tables/${tbl}/insertAll`,
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body);
  if (!res.ok) throw new Error('log insert failed: ' + JSON.stringify(res.data).slice(0, 200));
  if (res.data && res.data.insertErrors && res.data.insertErrors.length) {
    throw new Error('log insert errors: ' + JSON.stringify(res.data.insertErrors).slice(0, 200));
  }
  return true;
}

/** Build a logger for the pipeline. Returns null (disabled) when no table is set. */
function makeLogger({ project, token, table, client }) {
  if (!table) return null;
  return async (meta) => insertLog(project, token, table, buildLogRow({ client, ...meta })).catch(() => {});
}

module.exports = { buildLogRow, insertLog, makeLogger };
