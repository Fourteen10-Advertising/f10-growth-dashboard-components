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
3. In Netlify, set these. `GOOGLE_SERVICE_ACCOUNT` is a **site-level** environment variable set to the
   key of this client's own scoped service account, `dash-<client>@mcc-poc-477801` (marked
   secret, production and deploy-preview contexts). It reads only the client's
   `<prefix>_marts` and `<prefix>_reporting` datasets. This is required: there is no
   organisation or account default, and a site without it fails closed. Never use the
   shared cross-client reader. Create the service account, vault secret
   (`BIGQUERY_SA_JSON__<CLIENT>`) and isolation check by following
   `templates/client-sa/README.md` in the HQ company folder (the dashboard skills do this
   in "Step 6b"). Netlify applies a changed variable only on the next deploy, so redeploy
   after setting it. The dashboard must read only the client's own two datasets: if a tab
   needs anything else (previews, competitor data, HubSpot), add it to the client's marts in
   f10-dataform rather than reading a shared dataset.
   - `ALLOWED_ORIGIN` — this site's own origin (e.g. `https://acme.netlify.app`),
     to activate the CORS lock on the `bq` function.
4. Password protect the site in Netlify (site password or SSO) before sharing the URL. This
   is required, not optional: the `bq` function runs any SQL it is sent and is not an
   auth boundary, so the password is the access control. Save it in HQ secrets as
   `DASHBOARD_PASSWORD__<SITE>`; the client lead posts and pins it in the client's
   internal Slack channel. Confirm the live site returns 401 when unauthenticated.
5. Deploy. No build step — Netlify publishes the static files and the `bq.js`
   function (which has no npm dependencies).

## Keeping up to date

Bump the `@vX.Y.Z` tag in the three jsDelivr URLs in `index.html` to pick up new
shared-component releases. Never inline or fork the shared CSS/JS — to change
shared behaviour, edit the components repo and cut a new release.
