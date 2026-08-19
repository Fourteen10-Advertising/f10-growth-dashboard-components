/**
 * github.js — server-side GitHub client for the "Add to my dashboard" flow
 * (PRD US-010).
 *
 * The GitHub credential lives ONLY here, server-side. Two auth modes are
 * supported:
 *   - GitHub App (preferred): sign a short app JWT with the app private key, then
 *     exchange it for an installation token scoped to the org, with issues:write.
 *   - A fine-grained PAT (GITHUB_TOKEN) scoped to the repo, as a fallback.
 *
 * The browser never sees any token. Pure Node https + crypto (no @octokit dep),
 * matching the rest of the function library. The issue-body builder and the
 * fingerprint (used to dedup repeat requests) are pure and unit-tested.
 */

'use strict';

const crypto = require('crypto');
const https = require('https');

const API_HOST = 'api.github.com';
const UA = 'f10-ask-tab';

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

/** A short-lived GitHub App JWT (max 10 min), signed with the app private key. */
function appJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: String(appId) }));
  const sigInput = `${header}.${payload}`;
  const key = privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey;
  const sig = crypto.createSign('RSA-SHA256').update(sigInput).sign(key, 'base64url');
  return `${sigInput}.${sig}`;
}

/** Exchange an app JWT for an installation access token. */
async function installationToken(appId, privateKey, installationId) {
  const jwt = appJwt(appId, privateKey);
  const res = await api('POST', `/app/installations/${installationId}/access_tokens`, jwt, null, true);
  if (!res.data || !res.data.token) throw new Error('failed to mint installation token');
  return res.data.token;
}

/** A stable fingerprint for a question+SQL pair, used to dedup repeat requests. */
function fingerprint(question, sql) {
  const norm = `${String(question).trim().toLowerCase().replace(/\s+/g, ' ')}::${String(sql || '').replace(/\s+/g, ' ').trim()}`;
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

function buildIssueTitle(question) {
  const q = String(question).trim().replace(/\s+/g, ' ');
  return `Ask request: ${q.length > 80 ? q.slice(0, 77) + '...' : q}`;
}

/** A build-ready issue body: the question, validated SQL, viz spec, and a preview. */
function buildIssueBody({ question, sql, vizSpec, client, datasets, fp }) {
  const v = vizSpec || {};
  const preview = previewTable(v);
  return [
    `**Client:** ${client || 'unknown'}`,
    `**Datasets:** ${(datasets || []).join(', ') || 'unknown'}`,
    `**Requested from:** the Ask tab`,
    ``,
    `### Question`,
    `> ${String(question).trim()}`,
    ``,
    `### Suggested visualisation`,
    `- Chart type: \`${v.chartType || 'unknown'}\``,
    `- Title: ${v.title || '(none)'}`,
    v.dateRange ? `- Date range: ${v.dateRange.start} to ${v.dateRange.end}` : `- Date range: (from the question)`,
    `- Rows returned: ${v.rowCount != null ? v.rowCount : 'unknown'}`,
    v.interpretation ? `- Interpretation: ${v.interpretation}` : '',
    ``,
    `### Validated SQL`,
    '```sql',
    String(sql || '').trim(),
    '```',
    ``,
    `### Preview`,
    preview,
    ``,
    `### Viz spec`,
    '```json',
    JSON.stringify(stripRows(v), null, 2),
    '```',
    ``,
    `<!-- ask-fingerprint: ${fp} -->`,
  ].filter(l => l !== '').join('\n');
}

function stripRows(v) { const { rows, ...rest } = v || {}; return rest; }

function previewTable(v) {
  const rows = (v && v.rows) || [];
  if (!rows.length) return '_No rows returned._';
  const cols = (v.columns || (v.series ? [{ key: v.x && v.x.key, label: (v.x && v.x.label) || 'x' }, ...v.series.map(s => ({ key: s.key, label: s.label }))] : Object.keys(rows[0]).map(k => ({ key: k, label: k }))));
  const head = `| ${cols.map(c => c.label).join(' | ')} |`;
  const sep = `| ${cols.map(() => '---').join(' | ')} |`;
  const body = rows.slice(0, 10).map(r => `| ${cols.map(c => String(r[c.key] == null ? '' : r[c.key])).join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

/** Find an existing open issue with this fingerprint. Returns its html_url or null. */
async function findIssueByFingerprint(token, repo, fp) {
  const q = encodeURIComponent(`repo:${repo} in:body is:issue "ask-fingerprint: ${fp}"`);
  const res = await api('GET', `/search/issues?q=${q}`, token);
  const items = (res.data && res.data.items) || [];
  return items.length ? items[0].html_url : null;
}

async function createIssue(token, repo, { title, body, labels, assignees }) {
  const payload = JSON.stringify({ title, body, labels: labels || undefined, assignees: assignees || undefined });
  const res = await api('POST', `/repos/${repo}/issues`, token, payload);
  if (!res.data || !res.data.html_url) throw new Error('failed to create issue: ' + JSON.stringify(res.data).slice(0, 200));
  return res.data.html_url;
}

function api(method, path, token, body, isJwt) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(body) : null;
    const headers = {
      'User-Agent': UA,
      Accept: 'application/vnd.github+json',
      Authorization: `${isJwt ? 'Bearer' : 'token'} ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(buf ? { 'Content-Type': 'application/json', 'Content-Length': buf.length } : {}),
    };
    const req = https.request({ hostname: API_HOST, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

module.exports = {
  appJwt, installationToken, fingerprint,
  buildIssueTitle, buildIssueBody, previewTable,
  findIssueByFingerprint, createIssue,
};
