# Ask tab semantic model and viz-spec contract

This document defines two contracts that the growth dashboard "Ask" tab is built
on:

1. The **semantic model**: a small, per-client config of approved sources,
   dimensions and metrics. It is what lets the Ask pipeline answer most questions
   with accurate, pre-vetted SQL instead of inventing queries.
2. The **viz-spec contract**: the typed shape the Ask pipeline returns to the
   browser, so answers render through the existing shared builders and look like
   the rest of the dashboard.

The curated resolver that turns a metric-spec into SQL and a viz-spec lives in
`starter/netlify/functions/ask-lib/resolve.js`. The FastCover pilot model is
`starter/netlify/functions/ask-lib/models/fastcover.json`, seeded
from the standing FastCover dashboard so curated answers reconcile with the
report.

## Why curated first

The Ask pipeline is hybrid. It tries the curated metric path first and only falls
back to guarded text-to-SQL for the long tail. The curated path is accurate,
consistent and safe by construction: every table, column and aggregation comes
from the model, and the only user-supplied values that ever reach SQL are filter
values, which are escaped and checked against the model's allowlist. The
guarded text-to-SQL fallback and its dry-run checks are added by the ask function
(US-006) and the query-path hardening (US-007).

## Semantic model schema

A model is a JSON object with these top-level keys.

| Key | Type | Meaning |
| --- | --- | --- |
| `client` | string | Client slug. |
| `project` | string | BigQuery project id. Always `mcc-poc-477801` for F10. |
| `location` | string | BigQuery region, `australia-southeast1`. |
| `datasets` | string[] | The dataset allowlist. Every source table must live in one of these, and nothing else may be read. |
| `dateGrains` | string[] | Grains the client allows, from `day`, `week`, `month`. |
| `limits` | object | `{ defaultRows, maxRows }`. Every generated query is limited; `maxRows` is the hard cap. |
| `sources` | object | Map of source id to a source definition (see below). |
| `questions` | array | Curated question templates for the deterministic matcher and the model's few-shot examples. |

### Source definition

```json
"blended": {
  "label": "All Channels (blended)",
  "table": "fastcover_reporting.rollup_platform_daily",
  "dateColumn": "date",
  "grains": ["day", "week", "month"],
  "dimensions": { "platform": { "column": "platform", "label": "Platform", "options": ["meta", "gads"] } },
  "defaultFilters": [],
  "metrics": {
    "spend": { "label": "Spend", "sql": "SUM(spend)", "format": "money" },
    "cpa":   { "label": "CPA", "sql": "SAFE_DIVIDE(SUM(spend), SUM(primary_conversions))", "format": "money", "invert": true }
  }
}
```

- `table` is `dataset.table` and its dataset must be in `datasets`.
- `dateColumn` is the column every query filters and buckets on.
- `dimensions` are the group-by columns a client may slice by. An optional
  `options` array constrains the allowed filter values for that dimension; a value
  outside it is rejected.
- `defaultFilters` are always applied (for example GA4 transactions filter
  `event_name = 'transactions'`).
- `metrics` map a metric id to a display `label`, an aggregation `sql` fragment,
  and a `format`. `invert: true` marks a cost metric where lower is better.

Metric `sql` fragments are aggregations over the source table (for example
`SUM(spend)` or `SAFE_DIVIDE(SUM(spend), SUM(conversions))`). They are correct
whether the query groups by a dimension, by a time bucket, both, or neither.

### Formats

| Format | Rendered as | Example |
| --- | --- | --- |
| `money` | AUD, whole dollars | `$12,340` |
| `count` | plain number | `1,204` |
| `roas` | multiple | `4.20x` |
| `fraction` | a 0 to 1 value shown as a percentage | `0.62` shows as `62.0%` |
| `pct` | an already-percentage number | `62.0%` |
| `text` | as-is | dimension labels |

## Metric-spec

A metric-spec is the small object the curated matcher (or Gemini, in US-006)
emits. The resolver turns it into SQL and a viz-spec.

```json
{
  "source": "blended",
  "metrics": ["spend", "conversions", "cpa", "revenue", "roas"],
  "dimension": "platform",
  "grain": null,
  "dateRange": { "preset": "last_month" },
  "filters": [{ "dimension": "platform", "value": "meta" }],
  "orderBy": { "metric": "spend", "dir": "desc" },
  "limit": 50,
  "viz": "table"
}
```

- `metrics` defaults to all of the source's metrics when omitted.
- `dimension` and `grain` are both optional. With neither, the query returns a
  single totals row (a KPI answer). With a `grain`, it returns a time series.
- `dateRange` accepts `{ start, end }`, `{ preset }` (for example `last_month`,
  `last_28_days`, `ytd`), or `{ lastDays: N }`. It defaults to the last 28 days.
- `viz` picks the chart type; if omitted the resolver chooses one from the shape
  (grain gives a combo chart, a dimension gives a table, neither gives KPI cards).

## Viz-spec contract

The Ask pipeline returns this to the browser. The `f10AskTab` component (US-009)
renders it only through the shared builders, never bespoke HTML.

```json
{
  "chartType": "table",
  "title": "All Channels (blended) by platform, 2026-07-01 to 2026-07-31",
  "interpretation": "Top platform by spend ...",
  "dateRange": { "start": "2026-07-01", "end": "2026-07-31" },
  "rowCount": 5,
  "columns": [
    { "label": "Platform", "key": "dim", "num": false, "format": "text" },
    { "label": "Spend", "key": "spend", "num": true, "format": "money" }
  ],
  "rows": [ { "dim": "meta", "spend": "48210" } ]
}
```

Every viz-spec carries `chartType`, `title`, `interpretation`, `dateRange`,
`rowCount` and `rows`. The rest depends on the chart type:

| chartType | Extra fields | Renders through |
| --- | --- | --- |
| `kpi` | `columns` (one per metric) | `kpiCard` |
| `table` | `columns` (dimension then metrics) | `buildTable` |
| `line` / `bar` | `x` and `series` | `f10ComboChart` |
| `combo` | `x` and `series` (first series is a bar, rest are lines) | `f10ComboChart` |

For chart types, `x` is `{ key, label }` (the bucket or dimension), and each
series is `{ label, key, format, kind, axis }`. `axis` is `cur` for money on the
left dollar axis, `cost` for a cost metric on the dashed right dollar axis, and
`cnt` for counts and ratios on the right count axis, matching `f10ComboChart`.

`rows` are the raw BigQuery result rows as objects keyed by column name (a
dimension lands under `dim`, a time bucket under `bucket`, each metric under its
id). The browser formats display values with the framework's `fmt*` helpers using
each column's `format`.

## Resolver API (`starter/netlify/functions/ask-lib/resolve.js`)

- `buildQuery(model, spec, { today })` returns `{ sql, referencedTables, start, end, metricIds, dimId, grain, source }`. The SQL is a single SELECT, always LIMITed, scoped to the model's datasets. It throws on any unknown source, metric or dimension, and on a filter value outside the allowlist.
- `buildVizSpec(model, spec, built, rows)` returns the viz-spec for the rows.
- `resolveQuestion(model, question)` is the deterministic keyword matcher. It returns `{ questionId, spec }` or `null` on a miss (the miss is where Gemini text-to-SQL takes over).
- `resolveCurated(model, question, { today })` chains the two: question to spec to SQL and viz shell.
- `validateModel(model)` returns an array of structural problems, empty when the model is well formed.

`today` is injected rather than read from the clock so resolution is pure and
testable. The ask function passes the real date; the tests pass a fixed date.

## Seeding a new client's model

1. Read the client's standing dashboard SQL (the per-tab `load` functions).
2. For each tab, add its source table, date column, dimensions and metric
   aggregations to the model, copying the exact SQL fragments so numbers
   reconcile with the standing report.
3. Keep the `datasets` allowlist to only that client's `{client}_marts` and
   `{client}_reporting` datasets.
4. Add a handful of `questions` entries that map the common phrasings for that
   client onto specs.
5. Run the tests after adapting the fixtures:
   `node --test starter/netlify/functions/ask-lib/*.test.mjs`.
