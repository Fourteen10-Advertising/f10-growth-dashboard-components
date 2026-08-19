/**
 * Tests for the introspection helpers (systematic coverage).
 *   node --test ask-lib/introspect.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import introspect from './introspect.js';
const { columnsSql, distinctSql, buildWarehouse, columnsInSql, curatedColumnsForSource, coverageReport, renderCoverage } = introspect;

const here = dirname(fileURLToPath(import.meta.url));
const model = JSON.parse(readFileSync(join(here, 'models', 'fastcover.json'), 'utf8'));

test('columnsSql and distinctSql target INFORMATION_SCHEMA / the table', () => {
  assert.match(columnsSql('mcc-poc-477801', 'fastcover_marts'), /fastcover_marts\.INFORMATION_SCHEMA\.COLUMNS/);
  assert.match(distinctSql('mcc-poc-477801', 'fastcover_marts', 'age_gender_daily', 'age', 25), /LIMIT 25/);
});

test('buildWarehouse groups flat rows into tables with columns', () => {
  const rows = [
    { dataset: 'fastcover_marts', table_name: 'age_gender_daily', column_name: 'date', data_type: 'DATE' },
    { dataset: 'fastcover_marts', table_name: 'age_gender_daily', column_name: 'age', data_type: 'STRING' },
    { dataset: 'fastcover_marts', table_name: 'age_gender_daily', column_name: 'spend', data_type: 'FLOAT64' },
  ];
  const w = buildWarehouse(rows, '2026-08-19T00:00:00Z');
  assert.equal(w.generatedAt, '2026-08-19T00:00:00Z');
  assert.equal(w.tables['fastcover_marts.age_gender_daily'].columns.length, 3);
  assert.deepEqual(w.tables['fastcover_marts.age_gender_daily'].columns[1], { name: 'age', type: 'STRING' });
});

test('columnsInSql extracts columns and drops SQL functions/keywords', () => {
  const cols = columnsInSql('SAFE_DIVIDE(SUM(spend), SUM(primary_conversions))');
  assert.ok(cols.has('spend'));
  assert.ok(cols.has('primary_conversions'));
  assert.ok(!cols.has('sum'));
  assert.ok(!cols.has('safe_divide'));
});

test('curatedColumnsForSource covers metric, dimension and date columns', () => {
  const cols = curatedColumnsForSource(model.sources.blended);
  assert.ok(cols.has('spend'));
  assert.ok(cols.has('primary_conversions'));
  assert.ok(cols.has('revenue'));
  assert.ok(cols.has('platform')); // dimension column
  assert.ok(cols.has('date'));     // date column
});

test('coverageReport flags uncovered columns and unmodelled tables', () => {
  const warehouse = {
    tables: {
      'fastcover_marts.meta_campaign_daily': { columns: [
        { name: 'date_start', type: 'DATE' }, { name: 'campaign_name', type: 'STRING' },
        { name: 'spend', type: 'FLOAT64' }, { name: 'purchase', type: 'FLOAT64' },
        { name: 'quote', type: 'FLOAT64' }, { name: 'link_clicks', type: 'INT64' }, // not curated
      ] },
      'fastcover_marts.some_new_table': { columns: [{ name: 'x', type: 'INT64' }] }, // not modelled
      'bridgit_marts.secret': { columns: [{ name: 'y', type: 'INT64' }] }, // out of allowlist -> ignored
    },
  };
  const rep = coverageReport(model, warehouse);
  const meta = rep.perTable.find(t => t.table === 'fastcover_marts.meta_campaign_daily');
  assert.ok(meta.uncovered.includes('link_clicks'), 'uncovered column surfaced');
  assert.ok(!meta.uncovered.includes('spend'), 'curated column not flagged');
  assert.ok(rep.unmodelledTables.includes('fastcover_marts.some_new_table'));
  assert.ok(!rep.unmodelledTables.some(t => t.startsWith('bridgit')), 'out-of-allowlist tables ignored');
  assert.match(renderCoverage(model, rep, 'now'), /link_clicks/);
});
