# Ask tab (`f10AskTab`) and its analytics funnel

`f10AskTab(cfg)` is a shared growth-framework component (in `f10-growth-core.js`)
that returns a tab object to spread into a dashboard's `config.tabs`. It renders a
question box and shows the answer the server-side `ask` function returns as a
typed viz spec, drawn only through the shared builders (`kpiCard`, `buildTable`,
`makeChart`, `f10ComboChart`), so answers look like the rest of the dashboard. The
component never builds SQL and never sees a service account.

## Adding the tab to a client dashboard

```js
const DASHBOARD = {
  clientName: 'Fastcover',
  reportName: 'Growth Dashboard',
  // ... existing controls, filters, tabs ...
  tabs: [
    // ... existing tabs ...
    f10AskTab({
      client: 'fastcover',                                  // tagged on analytics
      requestFunction: '/.netlify/functions/ask-request',   // enables "Add to my dashboard" (US-010)
      suggestions: ['spend by platform', 'spend trend by week', 'top meta campaigns'],
    }),
  ],
};
```

`cfg` fields: `id`, `group`, `navLabel`, `title`, `sub`, `dot` (optional chrome),
`askFunction` (default `/.netlify/functions/ask`), `requestFunction` (optional; when
set, the "Add to my dashboard" action appears), `client`, and `suggestions`.

## What it renders

- A branded input row and example chips.
- The returned viz spec, as KPI cards, a table, or a chart, using only the shared
  builders. Table and dimension values are HTML-escaped.
- The plain-English interpretation, the date range, and the row count.
- A tidy inline error (never a broken layout) when the ask function fails.
- The "Add to my dashboard" action when `requestFunction` is set (US-010).

## Analytics funnel (US-011)

The tab fires PostHog events through the existing F10A facade
(`window.F10A.track`), each tagged with the `client` slug, so the funnel is
measurable per client on the shared PostHog project:

| Event | When | Extra props |
| --- | --- | --- |
| `ask.submitted` | a question is submitted | `question` |
| `ask.result_rendered` | a viz spec renders successfully | `chartType`, `rowCount` |
| `ask.add_to_dashboard_requested` | "Add to my dashboard" is clicked | |
| `ask.error` | the ask function returns an error | `message` |

The funnel from question asked, to result rendered, to dashboard request is
measurable per client. Events are best-effort: if the F10A facade is absent the
calls are no-ops and never break the tab.

## Verified

The tab was verified in a real browser against a stubbed ask endpoint: KPI, table
and combo-chart answers all render in F10 branding through the shared builders; an
error shows as a tidy inline message; the "Add to my dashboard" action moves to a
"Requested" state with a link to the issue; and `ask.submitted` then
`ask.result_rendered` fire through F10A.
