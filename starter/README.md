# Starter — new F10 growth dashboard

Copy this folder into a new repo to stand up a client growth dashboard. The
chrome, styling, and toolkit come from the shared `f10-growth-dashboard-components`
library via jsDelivr; this repo holds only the client config + the per-tab data
loaders.

## Steps

1. Copy the contents of this `starter/` folder to the root of the new repo.
2. Edit `index.html`:
   - `<title>` and `clientName` → the client.
   - `DATASET` → the client's BigQuery dataset (e.g. `acme_marts`).
   - Replace the example `tabs` with the client's real sections. Each tab needs a
     `body` (the HTML it renders into) and a `load(ctx)` (its SQL + render). Use
     the shared builders (`kpiCard`, `buildTable`, `makeChart`) and helpers
     (`runQuery`, `fmt*`, `computePeriods` via `ctx.dates`, `gGroup`, `sqlStr`).
   - Add any dropdown `filters` and list their ids on the tabs that use them.
3. In Netlify, set:
   - `GOOGLE_SERVICE_ACCOUNT` — service account JSON with BigQuery access
     (project `mcc-poc-477801`, location `australia-southeast1`). Usually already
     set at the organisation level.
   - `ALLOWED_ORIGIN` — this site's own origin (e.g. `https://acme.netlify.app`),
     to activate the CORS lock on the `bq` function.
4. Restrict access to the deployed site at the Netlify level (site password / SSO
   / IP allowlist) — the `bq` endpoint is read-only but is not an auth boundary.
5. Deploy. No build step — Netlify publishes the static files and the `bq.js`
   function (which has no npm dependencies).

## Keeping up to date

Bump the `@vX.Y.Z` tag in the three jsDelivr URLs in `index.html` to pick up new
shared-component releases. Never inline or fork the shared CSS/JS — to change
shared behaviour, edit the components repo and cut a new release.
