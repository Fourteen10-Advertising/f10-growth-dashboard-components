/**
 * bq-client.js — minimal BigQuery REST client for the Ask function.
 *
 * Pure Node https (no googleapis dependency), matching the existing bq.js proxy.
 * Adds a dry-run that returns the referenced tables and estimated bytes, which
 * the guard checks before any query is actually executed.
 *
 * The service account is the client-scoped SA (PRD US-002/US-003); it can only
 * read its own client's datasets, so even a bug here fails closed at IAM.
 */

'use strict';

const crypto = require('crypto');
const https = require('https');

const BQ_HOST = 'bigquery.googleapis.com';
const BQ_READONLY_SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly';

function b64url(str) { return Buffer.from(str).toString('base64url'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Mint an access token for the given scope by signing a JWT with the SA key. */
async function getAccessToken(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope,
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));
  const sigInput = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(sigInput);
  const key = sa.private_key.includes('\\n') ? sa.private_key.replace(/\\n/g, '\n') : sa.private_key;
  const sig = signer.sign(key, 'base64url');
  const jwt = `${sigInput}.${sig}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const res = await request('POST', 'oauth2.googleapis.com', '/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  if (!res.data || !res.data.access_token) {
    throw new Error('token exchange failed: ' + JSON.stringify(res.data).slice(0, 200));
  }
  return res.data.access_token;
}

function bqReadonlyToken(sa) { return getAccessToken(sa, BQ_READONLY_SCOPE); }

/**
 * Dry-run a query. Returns { referencedTables, totalBytesProcessed }.
 * Uses jobs.insert with configuration.dryRun so referencedTables is populated.
 */
async function dryRun(projectId, token, query, location = 'australia-southeast1') {
  const body = JSON.stringify({
    configuration: { dryRun: true, query: { query, useLegacySql: false } },
    jobReference: { projectId, location },
  });
  const res = await request('POST', BQ_HOST, `/bigquery/v2/projects/${projectId}/jobs`,
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body);
  if (!res.ok) {
    throw new Error('dry-run failed: ' + (res.data && res.data.error && res.data.error.message
      ? res.data.error.message : JSON.stringify(res.data).slice(0, 300)));
  }
  const stats = (res.data && res.data.statistics) || {};
  const q = stats.query || {};
  return {
    referencedTables: q.referencedTables || [],
    totalBytesProcessed: Number(q.totalBytesProcessed || stats.totalBytesProcessed || 0),
  };
}

/** Execute a query and return the raw BigQuery response ({ rows, schema, ... }). */
async function runQuery(projectId, token, query, opts = {}) {
  const location = opts.location || 'australia-southeast1';
  const body = JSON.stringify({
    query,
    useLegacySql: false,
    timeoutMs: opts.timeoutMs || 20000,
    maxResults: opts.maxResults || 10000,
    maximumBytesBilled: String(opts.maxBytes || (2 * 1024 * 1024 * 1024)),
    location,
  });
  const res = await request('POST', BQ_HOST, `/bigquery/v2/projects/${projectId}/queries`,
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body);
  if (!res.ok) {
    throw new Error('query error: ' + (res.data && res.data.error && res.data.error.message
      ? res.data.error.message : JSON.stringify(res.data).slice(0, 300)));
  }
  if (!res.data.jobComplete) return poll(projectId, res.data.jobReference.jobId, token, location);
  return res.data;
}

async function poll(projectId, jobId, token, location) {
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const res = await request('GET', BQ_HOST,
      `/bigquery/v2/projects/${projectId}/queries/${jobId}?timeoutMs=1000&maxResults=10000&location=${location}`,
      { Authorization: `Bearer ${token}` });
    if (res.data && res.data.jobComplete) return res.data;
    if (res.data && res.data.status && res.data.status.errorResult) {
      throw new Error(res.data.status.errorResult.message);
    }
  }
  throw new Error('query did not complete within 20 seconds');
}

/** Parse a BigQuery REST response into an array of plain row objects. */
function parseRows(data) {
  if (!data || !data.rows || !data.schema) return [];
  const fields = data.schema.fields.map(f => f.name);
  return data.rows.map(row => {
    const obj = {};
    row.f.forEach((cell, i) => { obj[fields[i]] = (cell.v === null || cell.v === undefined) ? null : cell.v; });
    return obj;
  });
}

function request(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(body) : null;
    const opts = { hostname, path, method, headers: { ...headers, ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}) } };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch { return reject(new Error(`non-JSON response (${res.statusCode}): ${text.slice(0, 300)}`)); }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

module.exports = {
  BQ_READONLY_SCOPE,
  getAccessToken, bqReadonlyToken,
  dryRun, runQuery, poll, parseRows, request,
};
