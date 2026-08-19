#!/usr/bin/env node
/**
 * build-semantic-model.mjs — enrich a client's semantic model from the warehouse.
 *
 * Reads BigQuery INFORMATION_SCHEMA for each of the model's allowed datasets and:
 *   - records every table + column into the model's `warehouse` section (fed to
 *     the guarded text-to-SQL fallback so any column is reachable), and
 *   - refreshes each plain-column dimension's `options` from real distinct values
 *     (so the model always knows the actual values, no hardcoding), and
 *   - writes a coverage report of columns available but not yet curated.
 *
 * Read-only against BigQuery. Runs under the client's scoped service account, e.g.
 * via the HQ helper:
 *   resolve-client-sa.sh --client fastcover -- \
 *     node tools/build-semantic-model.mjs --model starter/netlify/functions/ask-lib/models/fastcover.json
 *
 * Credential: GOOGLE_SERVICE_ACCOUNT or BIGQUERY_SA_JSON (raw SA JSON) in the env.
 *
 * Flags:
 *   --model <path>      (required) the base semantic model JSON to enrich
 *   --out <path>        write result here (default: overwrite --model)
 *   --coverage <path>   coverage report md (default: <model-dir>/<client>.coverage.md)
 *   --max-values <n>    cap distinct values per dimension (default 50)
 *   --no-values         skip distinct-value sampling (schema only)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bq = require('../starter/netlify/functions/ask-lib/bq-client.js');
const introspect = require('../starter/netlify/functions/ask-lib/introspect.js');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

const modelPath = arg('model');
if (!modelPath) { console.error('ERROR: --model <path> is required'); process.exit(2); }
const outPath = arg('out', modelPath);
const maxValues = Number(arg('max-values', 50)) || 50;
const skipValues = arg('no-values', false) === true;

const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT || process.env.BIGQUERY_SA_JSON;
if (!saRaw) { console.error('ERROR: set GOOGLE_SERVICE_ACCOUNT or BIGQUERY_SA_JSON (raw SA JSON)'); process.exit(2); }
const sa = JSON.parse(saRaw);
if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');

const model = JSON.parse(readFileSync(modelPath, 'utf8'));
const project = model.project;
const location = model.location || 'australia-southeast1';
const coveragePath = arg('coverage', join(dirname(modelPath), `${model.client}.coverage.md`));

async function q(sql) {
  const token = await bq.bqReadonlyToken(sa);
  const data = await bq.runQuery(project, token, sql, { location });
  return bq.parseRows(data);
}

const run = async () => {
  const stamp = new Date().toISOString();
  console.error(`Introspecting ${model.client} (${(model.datasets || []).join(', ')})...`);

  // 1. Full column inventory per dataset.
  let colRows = [];
  for (const dataset of model.datasets || []) {
    const rows = await q(introspect.columnsSql(project, dataset));
    for (const r of rows) colRows.push({ dataset, table_name: r.table_name, column_name: r.column_name, data_type: r.data_type });
  }
  const warehouse = introspect.buildWarehouse(colRows, stamp);
  model.warehouse = warehouse;
  console.error(`  ${Object.keys(warehouse.tables).length} tables, ${colRows.length} columns recorded.`);

  // 2. Refresh plain-column dimension options from real distinct values.
  if (!skipValues) {
    for (const [sid, src] of Object.entries(model.sources || {})) {
      const [dataset, table] = src.table.split('.');
      for (const [did, dim] of Object.entries(src.dimensions || {})) {
        if (dim.sql || !dim.column) continue; // expression dims keep curated options
        try {
          // Sample one over the cap so we can tell a COMPLETE set from a truncated one.
          const vals = await q(introspect.distinctSql(project, dataset, table, dim.column, maxValues + 1));
          const options = vals.map(r => r.v).filter(v => v !== null && v !== undefined).map(String);
          // Only constrain a dimension when we have its full, low-cardinality value
          // set. A high-cardinality column (e.g. campaign_name) is left unconstrained
          // so filters on any value still pass; the dry-run + allowlist guard it.
          if (options.length && options.length <= maxValues) { dim.options = options; console.error(`  ${sid}.${did}: ${options.length} values (constrained)`); }
          else { delete dim.options; console.error(`  ${sid}.${did}: high-cardinality (> ${maxValues}), left unconstrained`); }
        } catch (e) { console.error(`  ${sid}.${did}: skip (${e.message.slice(0, 80)})`); }
      }
    }
  }

  // 3. Coverage report.
  const report = introspect.coverageReport(model, warehouse);
  writeFileSync(coveragePath, introspect.renderCoverage(model, report, stamp));

  writeFileSync(outPath, JSON.stringify(model, null, 2) + '\n');
  console.error(`Wrote ${outPath}`);
  console.error(`Wrote ${coveragePath}`);
  const uncovered = report.perTable.reduce((n, t) => n + t.uncovered.length, 0);
  console.error(`Coverage: ${uncovered} uncovered columns across ${report.perTable.length} modelled tables; ${report.unmodelledTables.length} tables not modelled.`);
};

run().catch(e => { console.error('FAILED:', e && e.message ? e.message : e); process.exit(1); });
