# ask-lib — the Ask function library

Shared, dependency-free CommonJS modules behind the growth dashboard Ask tab. They
ship inside the Netlify function directory (like `bq.js`) so each client site is
self-contained after the starter is copied.

| File | Role |
| --- | --- |
| `resolve.js` | Curated resolver: metric-spec to SELECT-only, LIMITed SQL, plus the viz-spec. Pure. |
| `guard.js` | Query-path hardening: single-statement enforcement, LIMIT, dry-run dataset allowlist, bytes cap. |
| `gemini.js` | Vertex AI Gemini client and prompt builders (spec mapping, text-to-SQL fallback, interpretation). |
| `bq-client.js` | BigQuery REST client: token, dry-run (referenced tables + bytes), execute. |
| `pipeline.js` | The hybrid resolution flow, with the guard at the single gate. Clients are injected. |
| `github.js` | Server-side GitHub client for the "Add to my dashboard" flow (app JWT, installation token, issue create/dedup). |
| `cache.js` / `ratelimit.js` / `log.js` | Cost and rate controls: TTL cache, per-site limiter, BigQuery question log. |
| `models/<client>.json` | Semantic-model seeds kept in the framework for reference. |

The Netlify handlers are `../ask.js` (answers) and `../ask-request.js` ("Add to
my dashboard").

## "Add to my dashboard" (ask-request.js) env

- `GITHUB_REPO` — `owner/repo` of the client's dashboard repo (required).
- Auth, one of: `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` +
  `GITHUB_APP_INSTALLATION_ID` (preferred, a GitHub App with issues:write), or a
  fine-grained `GITHUB_TOKEN` with issues:write on the repo.
- `GITHUB_ISSUE_LABEL` (default `ask-request`), `GITHUB_ISSUE_ASSIGNEE` (optional).
- On the client dashboard, pass `requestFunction: '/.netlify/functions/ask-request'`
  to `f10AskTab(cfg)` to show the action.

## Per-client wiring

1. Copy this client's semantic model to the site's function directory as
   `netlify/functions/semantic-model.json`
   (from `ask-lib/models/<client>.json`).
2. Set `GOOGLE_SERVICE_ACCOUNT` on the Netlify site to the client's SCOPED service
   account JSON (the one that can read only that client's datasets).
3. Grant that service account `roles/aiplatform.user` on the project so it can
   call Vertex AI Gemini (provisioning covers this).
4. Optional env: `BQ_PROJECT_ID` (default `mcc-poc-477801`), `ASK_GEMINI_MODEL`
   (default `gemini-3.6-flash`), `ASK_GEMINI_LOCATION` (default `global`; Gemini's
   region, separate from BigQuery's — `global` unlocks newer models not offered in
   `australia-southeast1`, at the cost of the prompt and sample rows leaving AU),
   `ASK_LOCATION` (BigQuery data location, default `australia-southeast1`),
   `ALLOWED_ORIGIN` (CORS lock, same as `bq.js`).
5. Optional cost/rate controls (US-008): `ASK_LOG_TABLE` (`dataset.table`, e.g.
   `dashboard_ops.dashboard_ai_log`; logging is off when unset), `ASK_RATE_LIMIT`
   (requests per window, default 30), `ASK_RATE_WINDOW_MS` (default 60000),
   `ASK_CACHE_TTL_MS` (default 60000). When `ASK_LOG_TABLE` is set, the client's
   scoped SA also needs `roles/bigquery.dataEditor` on ONLY that log table
   (table-level IAM).

## Question log (US-008)

Every ask writes one row to `ASK_LOG_TABLE`, including the asks that FAIL. A
failed ask (`outcome != 'ok'`) is the highest-value signal in the log: it is a
question a client wanted answered that the dashboard could not, so mining the
failures is how you decide what to curate or build next.

Create the table once (shared across clients, since `client` is a column):

```sql
CREATE TABLE IF NOT EXISTS `mcc-poc-477801.dashboard_ops.dashboard_ai_log` (
  client STRING, question STRING, path STRING, sql STRING,
  bytes_billed INT64, row_count INT64, latency_ms INT64,
  outcome STRING, error STRING, ts TIMESTAMP
);
```

`outcome` is `ok` on success, or a reason code: `cannot_answer`,
`too_much_data`, `model_unavailable`, `unsafe_sql`, `out_of_scope_table`,
`bad_request`, `error`. `error` holds the underlying cause (e.g. the BigQuery
dry-run message) for failures and is `null` on success. Inserts use
`ignoreUnknownValues`, so a table created before the `error` column was added
keeps logging every other field until it is migrated with:

```sql
ALTER TABLE `mcc-poc-477801.dashboard_ops.dashboard_ai_log` ADD COLUMN IF NOT EXISTS error STRING;
```

Rank the unmet demand per client:

```sql
SELECT client, question, COUNT(*) AS asks, ANY_VALUE(error) AS sample_error
FROM `mcc-poc-477801.dashboard_ops.dashboard_ai_log`
WHERE outcome != 'ok' AND ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY client, question
ORDER BY asks DESC;
```

## Tests

```
node --test netlify/functions/ask-lib/*.test.mjs
```

The tests are zero-dependency (`node:test`) and cover resolver correctness, the
query guard, and the full pipeline with fake clients (no network).
