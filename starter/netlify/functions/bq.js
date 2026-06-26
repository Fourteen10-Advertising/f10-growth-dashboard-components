/**
 * Netlify Function: BigQuery proxy
 * Uses Node https module (no fetch required — works on Node 14/16/18)
 *
 * Security guardrails (all env-configurable, sensible defaults):
 *   ALLOWED_ORIGIN        — if set, the only browser origin allowed to call this
 *                           endpoint cross-origin. The dashboard calls its own
 *                           function same-origin, so this can stay unset; when it
 *                           is set, cross-origin callers are refused a CORS grant.
 *   BQ_MAX_BYTES_BILLED   — max bytes BigQuery may bill per query (default ~2 GB).
 *                           Queries that would scan more are rejected by BigQuery,
 *                           capping the cost/impact of any single request.
 *   BQ_TIMEOUT_MS         — per-query timeout in ms (default 9000).
 *
 * Note: this endpoint runs read-only queries with a service account scoped to
 * BigQuery readonly. It is not an authentication boundary — restrict access to
 * the deployed site at the Netlify level (site password / SSO / IP allowlist).
 */

const crypto = require('crypto');
const https  = require('https');

const MAX_BYTES_BILLED = process.env.BQ_MAX_BYTES_BILLED || String(2 * 1024 * 1024 * 1024);
const TIMEOUT_MS       = Number(process.env.BQ_TIMEOUT_MS || 9000);
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN || '';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...cors(event),
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(event), body: 'Method not allowed' };
  }

  try {
    const { query } = JSON.parse(event.body || '{}');

    if (!query || typeof query !== 'string' || !query.trim()) {
      return { statusCode: 400, headers: cors(event), body: JSON.stringify({ error: 'Missing query' }) };
    }

    const upper = query.trim().toUpperCase();
    if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
      return { statusCode: 403, headers: cors(event), body: JSON.stringify({ error: 'Only SELECT/WITH queries permitted' }) };
    }

    const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT;
    if (!saRaw) throw new Error('GOOGLE_SERVICE_ACCOUNT environment variable is not set');

    const sa = JSON.parse(saRaw);

    // Fix private key if newlines were double-escaped when pasting into Netlify UI
    if (sa.private_key) {
      sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    }

    const token     = await getAccessToken(sa);
    // Run/bill all jobs against the F10 BigQuery project (org policy: always
    // mcc-poc-477801). Never use sa.project_id - a credential whose home
    // project differs, or a stray Netlify env override, silently 500s every
    // query (took down all growth dashboards 2026-06-26 while creative, which
    // pins this value, stayed up).
    const projectId = process.env.BQ_PROJECT_ID || 'mcc-poc-477801';
    const result    = await runQuery(projectId, token, query);

    return { statusCode: 200, headers: cors(event), body: JSON.stringify(result) };

  } catch (err) {
    // Log the full detail server-side; return a generic message so we never leak
    // BigQuery schema/table names or internal errors to the browser.
    console.error('[bq] error:', err && err.message ? err.message : err);
    return { statusCode: 500, headers: cors(event), body: JSON.stringify({ error: 'Query failed' }) };
  }
};

// ── BigQuery ──────────────────────────────────────────────────────────────────

async function runQuery(projectId, token, query) {
  const body = JSON.stringify({
    query,
    useLegacySql: false,
    timeoutMs: TIMEOUT_MS,
    maxResults: 10000,
    maximumBytesBilled: MAX_BYTES_BILLED,
    location: 'australia-southeast1'
  });

  const res = await request('POST',
    `bigquery.googleapis.com`,
    `/bigquery/v2/projects/${projectId}/queries`,
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body
  );

  if (!res.ok) {
    throw new Error('BigQuery query error: ' + (res.data?.error?.message || JSON.stringify(res.data).slice(0, 300)));
  }

  if (!res.data.jobComplete) {
    return poll(projectId, res.data.jobReference.jobId, token);
  }

  return res.data;
}

async function poll(projectId, jobId, token) {
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const res = await request('GET',
      'bigquery.googleapis.com',
      `/bigquery/v2/projects/${projectId}/queries/${jobId}?timeoutMs=1000&maxResults=10000&location=australia-southeast1`,
      { 'Authorization': `Bearer ${token}` }
    );
    if (res.data?.jobComplete) return res.data;
    if (res.data?.status?.errorResult) throw new Error(res.data.status.errorResult.message);
  }
  throw new Error('Query did not complete within 20 seconds');
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getAccessToken(sa) {
  const now     = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/bigquery.readonly',
    aud:   sa.token_uri,
    exp:   now + 3600,
    iat:   now
  }));

  const sigInput = `${header}.${payload}`;
  const signer   = crypto.createSign('RSA-SHA256');
  signer.update(sigInput);
  const sig = signer.sign(sa.private_key, 'base64url');
  const jwt = `${sigInput}.${sig}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  const res = await request('POST',
    'oauth2.googleapis.com',
    '/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  );

  if (!res.data?.access_token) {
    throw new Error('Token exchange failed: ' + JSON.stringify(res.data).slice(0, 200));
  }
  return res.data.access_token;
}

// ── HTTP helper (no fetch, pure https module) ─────────────────────────────────

function request(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(body) : null;
    const opts = {
      hostname,
      path,
      method,
      headers: {
        ...headers,
        ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {})
      }
    };

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data',  c => chunks.push(c));
      res.on('end',   () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try   { data = JSON.parse(text); }
        catch { return reject(new Error(`Non-JSON response (${res.statusCode}): ${text.slice(0, 300)}`)); }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });

    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function b64url(str) { return Buffer.from(str).toString('base64url'); }
function sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }

// CORS: echo the configured origin only when it matches; otherwise send no
// allow-origin header. Same-origin requests (the dashboard) work without it.
function cors(event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  const origin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || '';
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
    headers['Vary'] = 'Origin';
  }
  return headers;
}
