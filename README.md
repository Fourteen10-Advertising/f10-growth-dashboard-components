# f10-growth-dashboard-components

Shared CSS and JavaScript for F10 Netlify **growth** dashboards. Loaded by each dashboard via jsDelivr CDN — no build step required.

Where the [creative dashboard components](https://github.com/fourteen10-advertising/f10-creative-dashboard-components) bake a fixed report into the library (every creative dashboard is the same shape), growth dashboards differ a lot per client — different datasets, metrics, and channels. So this library is a **shell + toolkit**, not a finished report:

- **The library owns the chrome and orchestration** — the F10-branded sidebar, header, controls bar, tab switching, collapsible nav, per-tab filter visibility, the date-range and granularity controls, the loading overlay, and per-section error handling.
- **Each client owns its data** — the section bodies (KPI grids, tables, charts) and a `load(ctx)` function per tab that runs its BigQuery SQL and renders the result using the shared builders.

This keeps the look, feel, and plumbing identical across clients while leaving full room for per-client customisation.

## Files

| File | Purpose |
|---|---|
| `f10-growth-shared.css` | All shared styles: F10 brand tokens, sidebar, header, controls bar, KPI cards, tables, chart cards, badges, info/warn boxes, loading overlay |
| `f10-growth-core.js` | Toolkit: `runQuery()`/`parseBQ()`, formatters (`fmtAUD`, `fmtK`, `fmtPct`, `pct`, `chg`…), date/period maths (`computePeriods`, `gGroup`), `sqlStr()`/`sqlDate()`, and the `kpiCard()` / `buildTable()` / `makeChart()` / `f10ComboChart()` / `f10ToggleChart()` builders |
| `f10-growth-shell.js` | `renderGrowthDashboard(config)` — builds the chrome from a manifest and wires all orchestration. Load AFTER core |

## How to use in a dashboard

The entire dashboard body is `<div id="app"></div>`. Define a config manifest, load Chart.js + the three library files, then call `renderGrowthDashboard(config)`.

### 1. In `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-growth-dashboard-components@v0.1.0/f10-growth-shared.css" />
```

### 2. Body + scripts:

```html
<body>
<div id="app"></div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-growth-dashboard-components@v0.1.0/f10-growth-core.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-growth-dashboard-components@v0.1.0/f10-growth-shell.js"></script>
<script>
  const BQ_FUNCTION = '/.netlify/functions/bq'; /* leave as-is */

  const DASHBOARD = {
    clientName: 'Acme',
    reportName: 'Growth Dashboard',
    controls: { dateRange: true, defaultDays: 13 },
    filters: {
      group: { label: 'Group', options: ['Brand', 'Generic', 'Competitor'] },
    },
    tabs: [
      {
        id: 'overview', group: 'Google Ads', navLabel: 'Overview',
        title: 'Platform Growth — Year over Year',
        sub: 'Google Ads performance vs the same period last year.',
        filters: ['group'],
        body: `
          <div class="sub-label">Headline</div>
          <div class="kpi-grid" id="ov-kpis"></div>
          <div class="table-card">
            <div class="table-card-header">Campaign Breakdown</div>
            <div class="table-wrap" id="ov-table"></div>
          </div>`,
        load: async (ctx) => {
          const d = ctx.dates, g = ctx.filters.group;
          const where = g ? ` AND group_name = '${sqlStr(g)}'` : '';
          const rows = await runQuery(`
            SELECT campaign_name, SUM(spend) AS spend, SUM(clicks) AS clicks
            FROM \`mcc-poc-477801.acme_marts.gads_campaign_daily\`
            WHERE date_start BETWEEN '${d.s}' AND '${d.e}'${where}
            GROUP BY campaign_name ORDER BY spend DESC`);
          const tot = rows.reduce((a, r) => a + n(r.spend), 0);
          document.getElementById('ov-kpis').innerHTML =
            kpiCard('Total Spend', fmtAUDFull(tot));
          buildTable('ov-table',
            [{ label: 'Campaign' }, { label: 'Spend', num: true }, { label: 'Clicks', num: true }],
            rows.map(r => [r.campaign_name, fmtAUDFull(r.spend), fmtK(r.clicks)]));
        },
      },
    ],
    initialTab: 'overview',
  };

  renderGrowthDashboard(DASHBOARD);
</script>
</body>
```

## Config manifest contract

| Field | Required | Purpose |
|---|---|---|
| `clientName` | yes | Sidebar client label |
| `reportName` | no | Sidebar sub-label + default page title (default `Growth Dashboard`) |
| `controls.dateRange` | no | Show the From/To date inputs (default `true`) |
| `controls.defaultDays` | no | Days of look-back for the default start date (default `13`) |
| `controls.defaultGranularity` | no | Initial granularity for `gGroup()` (`day`/`week`/`month`, default `week`) |
| `filters` | no | Map of `{ id: { label, options, default?, allLabel?, required? } }`. `options` is an array of strings or `{ value, label }`, or an async function returning one. Rendered as a dropdown, shown only on tabs that list the id |
| `tabs[]` | yes | One entry per nav item (see below) |
| `initialTab` | no | Tab id to open first (default first tab) |

### Each `tab`

| Field | Required | Purpose |
|---|---|---|
| `id` | yes | Unique key; the section panel is `#tab-<id>` and its error slot `#err-<id>` |
| `group` | no | Sidebar group heading; tabs sharing a group are collapsed together |
| `navLabel` | no | Sidebar link text (falls back to `title`, then `id`) |
| `dot` | no | CSS colour for the nav dot (optional accent) |
| `title` / `sub` | no | Section header copy |
| `warn` | no | HTML for a warning box above the body |
| `filters` | no | Array of filter ids to show on this tab |
| `granularity` | no | `true` to show the Daily/Weekly/Monthly selector on this tab |
| `body` | yes | HTML for the section's inner content (the element ids your `load` writes into) |
| `load` | yes | `async (ctx) => {…}` — runs the SQL and renders. Throwing surfaces a tidy error in the tab; the shell handles the loading overlay |

### The `ctx` passed to `load`

```js
{
  tab,          // active tab id
  dates,        // computePeriods(start, end): { s, e, days, pyS, pyE, ppS, ppE } (null if dateRange is off)
  filters,      // { filterId: selectedValue } ('' means All)
  granularity,  // 'day' | 'week' | 'month'
}
```

Use `gGroup(field, ctx.granularity)` for trend grouping and `computePeriods` (already applied to `ctx.dates`) for YoY/PoP comparisons.

## Charts

Two shared chart builders sit on top of `makeChart()`:

### `f10ComboChart(canvasId, labels, series, opts?)`

A multi-axis bars + lines chart in the F10 growth "trend" look. Spend bars sit on the left `$` axis; each line lands on an axis chosen by its `axis` field:

| `axis` | Axis | Use for |
|---|---|---|
| `cur` | left `$` | spend / revenue (bars or lines) |
| `cnt` | right count | volumes (leads, clicks, deals) |
| `cost` | right `$`, dashed | cost metrics (CPC, CPA) |
| `cpl` | separate right `$`, dashed | a cost metric an order of magnitude below `cost` that needs its own scale |

An axis is created only when a **visible** series uses it, so dropping a metric also drops its axis and keeps the chart readable.

```js
f10ComboChart('trend', labels, [
  { label: 'Ad Spend', data: spend, kind: 'bar',  axis: 'cur',  color: '#64748b' },
  { label: 'ROAS',     data: roas,  kind: 'line', axis: 'cnt',  color: '#f59e0b' },
  { label: 'CPA',      data: cpa,   kind: 'line', axis: 'cost', color: '#fa023c' },
]);
```

`opts`: `{ moneyTick, tooltip }` — optional Chart.js overrides (defaults format AUD and special-case ROAS as `Nx`).

### `f10ToggleChart(canvasId, togglesId, labels, series, opts?)`

The same chart **plus a metric-toggle chip row** rendered into the element with id `togglesId`. Each chip shows/hides one metric; a hidden metric leaves the chart entirely — axis included. This is the F10 answer to *"don't ship a second, near-identical chart just to isolate one metric"*: ship one chart and let the reader choose what to see.

Series accept two extra fields:

- `key` — stable id for a series (falls back to `label`). Toggle state is keyed on it and **persists across redraws**, so re-calling with fresh data (after a horizon or filter change) keeps the viewer's selection.
- `on: false` — start the metric hidden. `toggle: false` — always show it and give it no chip (e.g. the spend bar).

```html
<div class="chart-card-head">
  <div class="chart-card-title">Spend vs ROAS, CPA &amp; CPL</div>
  <div class="metric-seg" id="cohort-metrics"></div>
</div>
<div class="chart-wrap"><canvas id="cohort-trend"></canvas></div>
```
```js
f10ToggleChart('cohort-trend', 'cohort-metrics', labels, [
  { key: 'spend', label: 'Ad Spend', data: spend, kind: 'bar',  axis: 'cur',  color: '#64748b' },
  { key: 'roas',  label: 'ROAS',     data: roas,  kind: 'line', axis: 'cnt',  color: '#f59e0b' },
  { key: 'cpa',   label: 'CPA',      data: cpa,   kind: 'line', axis: 'cost', color: '#fa023c' },
  { key: 'cpl',   label: 'CPL',      data: cpl,   kind: 'line', axis: 'cpl',  color: '#a78bfa' },
]);
```

Chips use the `.metric-seg` style (a multi-select cousin of `.seg`).

## Theming / branding

All colours are CSS variables on `:root` in `f10-growth-shared.css`:

```css
--young-blood: #4b000f;  /* sidebar + primary brand */
--stabilo: #c8ff00;       /* accent / active state */
--stabilo-red: #fa023c;   /* warnings / negatives */
--paper / --paper-dark;   /* card + border greys */
--good / --bad;           /* positive / negative deltas */
```

Type is Archivo. KPI cards, tables, chart cards, and badges all share the creative-reporting visual language so growth and creative dashboards look like one family. To restyle per client, override these variables in the dashboard's own `<style>` block.

## Security

Growth dashboards read BigQuery through a Netlify function (`netlify/functions/bq.js`, shipped in `starter/`). That proxy:

- locks CORS to `ALLOWED_ORIGIN` (no wildcard);
- caps cost with `maximumBytesBilled`;
- returns a generic error to the browser (no schema leakage) while logging detail server-side.

Always route client-built filter values through `sqlStr()` and dates through `sqlDate()` (the shell does the latter for the date controls automatically). The endpoint is **not** an authentication boundary — restrict access to the deployed site at the Netlify level (site password / SSO / IP allowlist), and set `ALLOWED_ORIGIN` to the site's own origin in the Netlify environment.

## Versioning

Each release is tagged (e.g. `v0.1.0`). Dashboards pin to a tag in their jsDelivr URLs and bump it to pick up changes. jsDelivr caches tags immutably, so always cut a **new** tag rather than re-pointing an existing one. Semver: patch for fixes, minor for new config/behaviour, major for breaking manifest changes.

## Release process

Because dashboards pin to a tag, a dashboard pointing at `@vX.Y.Z` 404s its assets until that tag exists. For every release:

1. **Merge the components PR** to `main`.
2. **Create and publish the tag** on `main` at the merge commit (`git tag vX.Y.Z <sha> && git push origin vX.Y.Z`, or GitHub → Releases). This must be done by someone with tag push access — it cannot be done from the Claude Code web sandbox, which is restricted to feature-branch pushes.
3. **Verify the tag resolves** (`git ls-remote --tags origin | grep vX.Y.Z`).
4. **Bump and merge the dashboard PRs** to the new tag; Netlify redeploys each site.
5. **Smoke-test** each deployed dashboard.

> During pre-release development a dashboard may point its jsDelivr URLs at a feature branch (e.g. `@claude/laughing-shannon-9f2atm`) to validate end-to-end, then switch to the cut tag once it exists.

## Dashboards using this library

- `fourteen10-advertising/bridgit-dashboard` (pilot)
## Doc-sync

Documentation moves with code in this repo:

- **CI (enforced):** the `doc-sync` GitHub Action fails a PR/push when code or
  config changes without a docs change. Add `[skip-docs]` to a commit message
  to bypass a change that genuinely needs none.
- **Local (fast catch):** after cloning, run once — `git config core.hooksPath
  .githooks` (or `sh .githooks/setup.sh`) — to enable the pre-commit hook that
  checks the same thing before you commit.
