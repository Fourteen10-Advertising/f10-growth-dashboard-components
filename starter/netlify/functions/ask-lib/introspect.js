/**
 * introspect.js — systematic data-coverage helpers for the semantic model.
 *
 * The semantic model is hand-curated for accuracy, but the warehouse holds more
 * than any one dashboard shows. These helpers let a build step read BigQuery's
 * INFORMATION_SCHEMA per client and:
 *   - record every table and column into the model's `warehouse` section, which
 *     is fed to the guarded text-to-SQL fallback so ANY column is reachable
 *     (still dry-run, allowlist and single-SELECT protected), and
 *   - produce a coverage report of which columns are modelled vs merely available,
 *     so real gaps (age bands, device, region, new columns) surface for curation.
 *
 * These functions are pure (SQL builders, parsing, diffing); the live queries and
 * file writes live in tools/build-semantic-model.mjs. CommonJS + dependency-free.
 */

'use strict';

/** INFORMATION_SCHEMA.COLUMNS query for one dataset. */
function columnsSql(project, dataset) {
  return `SELECT table_name, column_name, data_type
FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
ORDER BY table_name, ordinal_position`;
}

/** Distinct values for a column (capped), used to refresh a dimension's options. */
function distinctSql(project, dataset, table, column, limit = 50) {
  return `SELECT DISTINCT ${column} AS v
FROM \`${project}.${dataset}.${table}\`
WHERE ${column} IS NOT NULL
ORDER BY v
LIMIT ${Math.max(1, Math.min(Number(limit) || 50, 500))}`;
}

/** Approx distinct count, to spot low-cardinality (dimension-like) string columns. */
function approxDistinctSql(project, dataset, table, column) {
  return `SELECT APPROX_COUNT_DISTINCT(${column}) AS n
FROM \`${project}.${dataset}.${table}\``;
}

/**
 * Build the warehouse section from flat INFORMATION_SCHEMA rows.
 * rows: [{ dataset, table_name, column_name, data_type }]  (dataset injected by the caller)
 * -> { tables: { "dataset.table": { columns: [{ name, type }] } } }
 */
function buildWarehouse(rows, generatedAt) {
  const tables = {};
  for (const r of rows || []) {
    const key = `${r.dataset}.${r.table_name}`;
    (tables[key] = tables[key] || { columns: [] }).columns.push({ name: r.column_name, type: r.data_type });
  }
  return { generatedAt: generatedAt || null, tables };
}

// SQL words that appear in metric fragments but are not column names.
const SQL_STOPWORDS = new Set([
  'sum', 'avg', 'min', 'max', 'count', 'safe_divide', 'round', 'cast', 'coalesce', 'ifnull', 'nullif',
  'case', 'when', 'then', 'else', 'end', 'and', 'or', 'not', 'in', 'is', 'null', 'as', 'distinct',
  'approx_count_distinct', 'date_trunc', 'week', 'month', 'monday', 'true', 'false', 'over', 'partition', 'by',
]);

/** Best-effort set of column names referenced by a metric/dimension SQL fragment. */
function columnsInSql(sql) {
  const out = new Set();
  for (const tok of String(sql || '').toLowerCase().match(/[a-z_][a-z0-9_]*/g) || []) {
    if (!SQL_STOPWORDS.has(tok) && !/^\d/.test(tok)) out.add(tok);
  }
  return out;
}

/** Columns a source curates (metric fragments + dimension columns + date column). */
function curatedColumnsForSource(src) {
  const cols = new Set();
  if (src.dateColumn) cols.add(src.dateColumn.toLowerCase());
  for (const d of Object.values(src.dimensions || {})) {
    if (d.column) cols.add(d.column.toLowerCase());
    if (d.sql) for (const c of columnsInSql(d.sql)) cols.add(c);
  }
  for (const m of Object.values(src.metrics || {})) {
    for (const c of columnsInSql(m.sql)) cols.add(c);
  }
  for (const f of src.defaultFilters || []) if (f.column) cols.add(f.column.toLowerCase());
  return cols;
}

/**
 * Coverage report: for each modelled source table, which warehouse columns are
 * not referenced by any metric/dimension; and which warehouse tables in the
 * allowlisted datasets are not modelled by any source at all.
 */
function coverageReport(model, warehouse) {
  const sourceByTable = {};
  for (const [sid, src] of Object.entries(model.sources || {})) {
    sourceByTable[`${model.project}.${src.table}`.replace(`${model.project}.`, '')] = { sid, src };
  }
  const modelledTables = new Set(Object.values(model.sources || {}).map(s => s.table));

  const perTable = [];
  const unmodelledTables = [];
  for (const [tkey, tinfo] of Object.entries((warehouse && warehouse.tables) || {})) {
    const dataset = tkey.split('.')[0];
    if (model.datasets && !model.datasets.includes(dataset)) continue;
    const entry = sourceByTable[tkey];
    if (!entry) { unmodelledTables.push(tkey); continue; }
    const curated = curatedColumnsForSource(entry.src);
    const uncovered = tinfo.columns
      .map(c => c.name)
      .filter(name => !curated.has(String(name).toLowerCase()));
    perTable.push({ table: tkey, source: entry.sid, uncovered });
  }
  return { perTable, unmodelledTables };
}

/** Render a coverage report as markdown. */
function renderCoverage(model, report, generatedAt) {
  const lines = [];
  lines.push(`# Semantic-model coverage: ${model.client}`);
  lines.push('');
  lines.push(`Generated: ${generatedAt || '(unknown)'}. Datasets: ${(model.datasets || []).join(', ')}.`);
  lines.push('');
  lines.push('This report is advisory. Curated metrics stay accurate; the guarded');
  lines.push('text-to-SQL fallback can already reach the columns below. Promote the ones');
  lines.push('worth a first-class, reconciled metric or dimension into the model.');
  lines.push('');
  lines.push('## Modelled tables — columns not yet curated');
  for (const t of report.perTable) {
    lines.push('');
    lines.push(`### ${t.table} (source: ${t.source})`);
    lines.push(t.uncovered.length ? t.uncovered.map(c => `- ${c}`).join('\n') : '- (all columns curated)');
  }
  if (report.unmodelledTables.length) {
    lines.push('');
    lines.push('## Allowed tables not modelled by any source');
    lines.push(report.unmodelledTables.map(t => `- ${t}`).join('\n'));
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  columnsSql, distinctSql, approxDistinctSql,
  buildWarehouse, columnsInSql, curatedColumnsForSource, coverageReport, renderCoverage,
};
