---
name: create-growth-dashboard
description: >-
  Scaffold a new F10 growth dashboard from the shared
  f10-growth-dashboard-components framework. Use when someone wants to create,
  set up, spin up, bootstrap, or add a new client growth dashboard / growth
  reporting dashboard. Gathers the client config (BigQuery dataset, channels,
  sections, filters), pulls the latest starter scaffold, fills in the config and
  a tab manifest, commits it, and prints the GitHub + Netlify deploy steps.
argument-hint: "[client name]"
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

# Create an F10 growth dashboard

Scaffold a new client growth reporting dashboard. The dashboard is a thin shell
that loads the shared `f10-growth-dashboard-components` library from jsDelivr —
the chrome, styling, and toolkit live there. This repo holds only the client
config and the per-tab data loaders.

Unlike creative dashboards (one fixed report shape), growth dashboards are
bespoke: every client has different datasets, metrics, and channels. So this
skill scaffolds the starter and then helps the user define their tabs — it does
NOT inline or duplicate the shared CSS/JS.

Work through the steps in order. Confirm the gathered config with the user
before writing files.

## Step 1 — Gather the client config

If a client name was passed as an argument, use it. Otherwise ask. Collect:

| Field | Required | Notes / examples |
|---|---|---|
| Client name | yes | e.g. `Acme`. Sidebar, `<title>`, default folder name |
| BigQuery dataset | yes | e.g. `acme_clean` |
| Channels / sources | yes | Which platforms have data and tables, e.g. Google Ads (`google_daily_campaign_performance`), Meta, GA4. Drives the sidebar groups |
| Sections per channel | yes | e.g. Growth YoY, Growth PoP, Over Time, Group breakdown. Each becomes a tab |
| Filters | no | Dropdowns (campaign, group, stream, channel…) and which tabs show them |
| Target folder | no | Default `<client-slug>-dashboard` (lowercase, hyphenated) |

Assume `PROJECT = mcc-poc-477801` and `BQ_FUNCTION = /.netlify/functions/bq`
unless told otherwise. See [reference.md](reference.md) for the manifest contract
and `ctx` shape.

Echo the collected config back and get a thumbs-up before proceeding.

## Step 2 — Resolve the latest components release tag

The scaffolded dashboard must pin to a real release tag. Resolve the latest:

```bash
TAG=$(curl -fsSL https://api.github.com/repos/fourteen10-advertising/f10-growth-dashboard-components/releases/latest \
  | grep -oE '"tag_name"[^,]*' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
echo "Latest components tag: ${TAG:-<none found>}"
```

If that returns nothing (API blocked), fall back to:

```bash
git ls-remote --tags https://github.com/fourteen10-advertising/f10-growth-dashboard-components.git \
  | awk -F/ '{print $NF}' | grep -E '^v[0-9]' | sort -V | tail -1
```

If you still cannot resolve a tag, ask the user which version to pin to.

## Step 3 — Scaffold the files from the starter at that tag

Pull the starter scaffold for the resolved `$TAG` into the target folder. The
starter already pins its jsDelivr URLs to the matching tag.

```bash
DIR="<target-folder>"
BASE="https://raw.githubusercontent.com/fourteen10-advertising/f10-growth-dashboard-components/${TAG}/starter"
mkdir -p "$DIR/netlify/functions"
curl -fsSL "$BASE/index.html"              -o "$DIR/index.html"
curl -fsSL "$BASE/package.json"            -o "$DIR/package.json"
curl -fsSL "$BASE/netlify.toml"            -o "$DIR/netlify.toml"
curl -fsSL "$BASE/netlify/functions/bq.js" -o "$DIR/netlify/functions/bq.js"
curl -fsSL "$BASE/README.md"               -o "$DIR/README.md"
```

If the network blocks raw.githubusercontent.com, reconstruct the files from the
canonical templates in [reference.md](reference.md), substituting `${TAG}` into
every jsDelivr URL.

## Step 4 — Fill in the config and build the tab manifest

Edit the new `index.html` only — never touch the script tags. Then:

- `<title>` → `<Client> | Growth Dashboard`; `clientName` → the client.
- `DATASET` → the client's dataset.
- Replace the two example tabs with the client's real sections. For each section
  the user wants, add a tab with: `id`, `group` (channel), `navLabel`, `title`,
  `sub`, optional `filters`/`granularity`, a `body` of the elements it renders
  into, and a `load(ctx)` that runs the SQL and renders via the shared builders.
- Define any `filters` and list their ids on the relevant tabs.
- Confirm all jsDelivr URLs reference the same `$TAG`, and no `CLIENT_NAME` /
  `your_dataset` placeholders remain.

Keep loaders safe: route every filter value through `sqlStr()` and only inline
dates from `ctx.dates` (already validated by the shell).

Build the tabs collaboratively — show the user each section's SQL and confirm
the metrics before moving on. If a channel has no data yet, add a `warn` note to
that tab rather than leaving it blank.

## Step 5 — Initialise git and commit

```bash
cd "$DIR"
git init -q && git add -A
git commit -q -m "Scaffold <Client> growth dashboard on components ${TAG}"
```

## Step 6 — Tell the user how to deploy

Print these next steps (do NOT create the GitHub repo or Netlify site yourself
unless asked):

1. Create a GitHub repo under `fourteen10-advertising` (e.g. `<client-slug>-dashboard`)
   and push this folder.
2. In Netlify, create a project from that repo. Set `ALLOWED_ORIGIN` to the
   site's own origin; `GOOGLE_SERVICE_ACCOUNT` is usually already set at the
   organisation level.
3. Restrict site access at the Netlify level (site password / SSO / IP allowlist).
4. Open the deployed site and click through each tab; confirm the date range,
   filters, and granularity controls re-query as expected.

## Guardrails

- This skill creates a config + loaders repo. Never copy the shared CSS, the
  shell, or the toolkit into it — that is what the library exists to prevent.
- To change shared behaviour for every client, edit
  `f10-growth-dashboard-components` and cut a new release; do not fork logic into
  a single dashboard.
