/**
 * Netlify Function: Ask -> "Add to my dashboard" (PRD US-010)
 *
 * Turns a rendered Ask answer into a build-ready GitHub issue on the client's
 * dashboard repo, assigned and labelled. The GitHub credential lives only here
 * (a GitHub App installation token, or a fine-grained PAT), never in the browser.
 *
 * It re-validates any SQL it is handed through the same guard as the ask function
 * (a tampered payload cannot smuggle a non-SELECT past it), and dedups repeat
 * requests by fingerprint so the same visualisation is not requested twice.
 *
 * Env:
 *   GITHUB_REPO               owner/repo of the client's dashboard (required)
 *   GITHUB_ISSUE_LABEL        default 'ask-request'
 *   GITHUB_ISSUE_ASSIGNEE     GitHub login to assign (optional)
 *   Auth (one of):
 *     GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID   (preferred)
 *     GITHUB_TOKEN            fine-grained PAT with issues:write on the repo
 *   GOOGLE_SERVICE_ACCOUNT    optional; when present, the SQL is also dry-run and
 *                             its referenced tables re-checked against the allowlist.
 */

'use strict';

const guard = require('./ask-lib/guard.js');
const github = require('./ask-lib/github.js');
const bq = require('./ask-lib/bq-client.js');

const REPO = process.env.GITHUB_REPO || '';
const LABEL = process.env.GITHUB_ISSUE_LABEL || 'ask-request';
const ASSIGNEE = process.env.GITHUB_ISSUE_ASSIGNEE || '';
const PROJECT = process.env.BQ_PROJECT_ID || 'mcc-poc-477801';
const LOCATION = process.env.ASK_LOCATION || 'australia-southeast1';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

let MODEL = null;
try { MODEL = require('./semantic-model.json'); } catch { MODEL = null; }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...cors(event), 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors(event), body: 'Method not allowed' };
  if (!REPO) return json(event, 501, { error: 'The request-to-dashboard feature is not configured for this site.' });

  try {
    const { question, sql, vizSpec } = JSON.parse(event.body || '{}');
    if (!question || !sql) return json(event, 400, { error: 'question and sql are required' });

    // Re-validate the SQL exactly as the ask function does. Fail closed.
    guard.assertSelectOnly(sql);
    const safeSql = guard.ensureLimit(sql, (MODEL && MODEL.limits && MODEL.limits.maxRows) || guard.DEFAULT_MAX_ROWS);

    // If a scoped SA and model are present, also dry-run and re-check the allowlist.
    if (MODEL && process.env.GOOGLE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
      if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
      // A dry-run creates a BigQuery job, which the read-only scope cannot do
      // ("insufficient authentication scopes"). Use the full bigquery scope,
      // matching the working ask function. IAM (dataViewer + jobUser on the
      // scoped SA) remains the real access boundary.
      const token = await bq.getAccessToken(sa, 'https://www.googleapis.com/auth/bigquery');
      const dry = await bq.dryRun(PROJECT, token, safeSql, LOCATION);
      guard.assertReferencedTables(dry.referencedTables, MODEL.datasets, MODEL.project || PROJECT);
    }

    const token = await resolveGithubToken();
    const fp = github.fingerprint(question, safeSql);

    // Dedup: if an open issue already carries this fingerprint, return it.
    const existing = await github.findIssueByFingerprint(token, REPO, fp);
    if (existing) return json(event, 200, { issueUrl: existing, deduped: true });

    const issueUrl = await github.createIssue(token, REPO, {
      title: github.buildIssueTitle(question),
      body: github.buildIssueBody({
        question, sql: safeSql, vizSpec,
        client: MODEL && MODEL.client, datasets: MODEL && MODEL.datasets, fp,
      }),
      labels: [LABEL],
      assignees: ASSIGNEE ? [ASSIGNEE] : undefined,
    });
    return json(event, 200, { issueUrl, deduped: false });
  } catch (err) {
    const status = (err && err.code === 'UNSAFE_SQL') || (err && err.code === 'OUT_OF_SCOPE_TABLE') ? 400 : 500;
    console.error('[ask-request] error:', err && err.message ? err.message : err);
    return json(event, status, { error: status === 400 ? 'This answer could not be turned into a request.' : 'Could not create the request right now.' });
  }
};

async function resolveGithubToken() {
  if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_INSTALLATION_ID) {
    return github.installationToken(process.env.GITHUB_APP_ID, process.env.GITHUB_APP_PRIVATE_KEY, process.env.GITHUB_APP_INSTALLATION_ID);
  }
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  throw new Error('no GitHub credential configured');
}

function json(event, statusCode, obj) { return { statusCode, headers: cors(event), body: JSON.stringify(obj) }; }

function cors(event) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  const origin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || '';
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) { headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN; headers['Vary'] = 'Origin'; }
  return headers;
}
