# Reference — create-growth-dashboard

Supporting detail for the `create-growth-dashboard` skill. The primary path is to
fetch the starter from the components repo at the latest release tag; use the
templates here only if the network blocks that fetch.

## Manifest contract

Defined in the dashboard's `index.html` as the `DASHBOARD` object passed to
`renderGrowthDashboard(DASHBOARD)`:

| Field | Required | Purpose |
|---|---|---|
| `clientName` | yes | Sidebar client label |
| `reportName` | no | Sidebar sub-label + default page title (default `Growth Dashboard`) |
| `controls.dateRange` | no | Show the From/To date inputs (default `true`) |
| `controls.defaultDays` | no | Look-back days for the default start date (default `13`) |
| `controls.defaultGranularity` | no | Initial granularity (`day`/`week`/`month`, default `week`) |
| `filters` | no | Map of `{ id: { label, options, default?, allLabel?, required? } }`. `options` is an array of strings or `{ value, label }`, or an async function returning one |
| `tabs[]` | yes | One entry per nav item (see below) |
| `initialTab` | no | Tab id to open first (default first tab) |

### Each `tab`

| Field | Required | Purpose |
|---|---|---|
| `id` | yes | Unique key; panel is `#tab-<id>`, error slot `#err-<id>` |
| `group` | no | Sidebar group heading (channel); tabs sharing a group collapse together |
| `navLabel` | no | Sidebar link text (falls back to `title`, then `id`) |
| `dot` | no | CSS colour for the nav dot |
| `title` / `sub` | no | Section header copy |
| `warn` | no | HTML for a warning box above the body (e.g. "channel launched recently") |
| `filters` | no | Array of filter ids to show on this tab |
| `granularity` | no | `true` to show the Daily/Weekly/Monthly selector |
| `body` | yes | HTML for the section's inner content (the ids `load` writes into) |
| `load` | yes | `async (ctx) => {…}` — runs SQL + renders. Throwing shows a tidy in-tab error |

### The `ctx` passed to `load`

```js
{
  tab,          // active tab id
  dates,        // computePeriods(start, end): { s, e, days, pyS, pyE, ppS, ppE } (null if dateRange off)
  filters,      // { filterId: selectedValue } ('' means All)
  granularity,  // 'day' | 'week' | 'month'
}
```

## Toolkit available to loaders (globals from `f10-growth-core.js`)

- **Data:** `runQuery(sql)` → array of row objects; `parseBQ(raw)`.
- **Escaping:** `sqlStr(v)` (single-quote escape — use on every filter value),
  `sqlDate(v)` (ISO-only).
- **Numbers/format:** `n`, `fmt`, `fmtAUD`, `fmtAUDFull`, `fmtK`, `fmtPct`, `pct`,
  `chg(curr, prev, invert)`.
- **Dates:** `today`, `daysAgo`, `addDays`, `subYear`, `diffDays`,
  `computePeriods(s, e)`, `gGroup(field, gran)`.
- **Builders:** `kpiCard(label, value, sub?, curr?, prev?, invert?, opts?)`,
  `buildTable(id, headers, rows)`, `makeChart(id, chartJsConfig)`, `getCSS(var)`.

Cost metrics (CPA/CPM/CPC) should pass `invert=true` to `kpiCard`/`chg` so a
lower value reads as an improvement.

## Fallback templates

Substitute `${TAG}` with the resolved release tag (e.g. `v0.1.0`) everywhere.

### index.html

Use the canonical `starter/index.html` from the components repo at `${TAG}`. Its
shape: `<head>` loads Archivo + `f10-growth-shared.css@${TAG}`; the body is a
single `<div id="app"></div>` followed by Chart.js, `f10-growth-core.js@${TAG}`,
`f10-growth-shell.js@${TAG}`, then a `<script>` defining `DASHBOARD` (clientName,
controls, filters, tabs[]) and calling `renderGrowthDashboard(DASHBOARD)`.

### netlify.toml

```toml
[build]
  publish = "."
  functions = "netlify/functions"

[build.environment]
  NODE_VERSION = "18"

[functions]
  node_bundler = "esbuild"

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "SAMEORIGIN"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
```

### package.json

```json
{
  "name": "growth-dashboard",
  "version": "1.0.0",
  "description": "Growth Dashboard — F10",
  "private": true
}
```

### netlify/functions/bq.js

Fetch from the components repo at `${TAG}` — it is the hardened BigQuery proxy
and should not be hand-rewritten. It reads `process.env.GOOGLE_SERVICE_ACCOUNT`,
runs the POSTed read-only `query` against BigQuery in `australia-southeast1`,
caps cost via `maximumBytesBilled`, locks CORS to `ALLOWED_ORIGIN`, and returns a
generic error to the client (full detail logged server-side). No npm
dependencies — pure Node `crypto`/`https`.
