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
| `models/<client>.json` | Semantic-model seeds kept in the framework for reference. |

The Netlify handler is `../ask.js`.

## Per-client wiring

1. Copy this client's semantic model to the site's function directory as
   `netlify/functions/semantic-model.json`
   (from `ask-lib/models/<client>.json`).
2. Set `GOOGLE_SERVICE_ACCOUNT` on the Netlify site to the client's SCOPED service
   account JSON (the one that can read only that client's datasets).
3. Grant that service account `roles/aiplatform.user` on the project so it can
   call Vertex AI Gemini (provisioning covers this).
4. Optional env: `BQ_PROJECT_ID` (default `mcc-poc-477801`), `ASK_GEMINI_MODEL`
   (default `gemini-2.5-flash`), `ASK_LOCATION` (default `australia-southeast1`),
   `ALLOWED_ORIGIN` (CORS lock, same as `bq.js`).

## Tests

```
node --test netlify/functions/ask-lib/*.test.mjs
```

The tests are zero-dependency (`node:test`) and cover resolver correctness, the
query guard, and the full pipeline with fake clients (no network).
