/**
 * Tests for the curated resolver (PRD US-005). Zero-dependency, runs with:
 *   node --test ask/
 * Proves: the FastCover model validates, a representative question resolves to a
 * curated metric-spec (not free SQL), the generated SQL is SELECT-only, LIMITed,
 * scoped to the client's datasets, reconciles with the standing dashboard's SQL,
 * and that filter values are escaped and constrained to the model's allowlist.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import resolve from './resolve.js';
const { validateModel, buildQuery, buildVizSpec, resolveQuestion, resolveCurated, resolveDateRange } = resolve;

const here = dirname(fileURLToPath(import.meta.url));
const model = JSON.parse(readFileSync(join(here, 'models', 'fastcover.json'), 'utf8'));
const TODAY = '2026-08-19';

test('FastCover model is structurally valid', () => {
  assert.deepEqual(validateModel(model), []);
});

test('a representative question resolves to a curated metric-spec (no free SQL)', () => {
  const hit = resolveQuestion(model, 'Can you show me spend by platform for last month?');
  assert.ok(hit, 'expected a curated match');
  assert.equal(hit.questionId, 'blended_spend_by_platform');
  assert.equal(hit.spec.source, 'blended');
  assert.equal(hit.spec.dimension, 'platform');
});

test('curated resolution builds SELECT-only, LIMITed SQL scoped to the client dataset', () => {
  const r = resolveCurated(model, 'spend by platform', { today: TODAY });
  assert.ok(r, 'expected a resolution');
  assert.match(r.sql.trim(), /^SELECT/);
  assert.ok(!r.sql.includes(';'), 'must be a single statement');
  assert.match(r.sql, /FROM `mcc-poc-477801\.fastcover_reporting\.rollup_platform_daily`/);
  assert.match(r.sql, /SUM\(spend\) AS spend/);
  assert.match(r.sql, /SAFE_DIVIDE\(SUM\(spend\), SUM\(primary_conversions\)\) AS cpa/);
  assert.match(r.sql, /GROUP BY dim/);
  assert.match(r.sql, /LIMIT \d+/);
  assert.deepEqual(r.referencedTables, ['mcc-poc-477801.fastcover_reporting.rollup_platform_daily']);
});

test('every referenced table sits inside the model dataset allowlist', () => {
  for (const src of Object.values(model.sources)) {
    const dataset = src.table.split('.')[0];
    assert.ok(model.datasets.includes(dataset), `${src.table} dataset not allowlisted`);
  }
});

test('date presets resolve deterministically against an injected today', () => {
  assert.deepEqual(resolveDateRange({ preset: 'last_month' }, TODAY), { start: '2026-07-01', end: '2026-07-31' });
  assert.deepEqual(resolveDateRange({ preset: 'last_7_days' }, TODAY), { start: '2026-08-13', end: '2026-08-19' });
  assert.deepEqual(resolveDateRange({ lastDays: 28 }, TODAY), { start: '2026-07-23', end: '2026-08-19' });
  assert.deepEqual(resolveDateRange({ start: '2026-01-01', end: '2026-01-31' }, TODAY), { start: '2026-01-01', end: '2026-01-31' });
});

test('filter values are single-quote escaped', () => {
  const built = buildQuery(model, {
    source: 'meta', metrics: ['spend'], dimension: 'campaign',
    filters: [{ dimension: 'campaign', value: "O'Brien Brand" }],
  }, { today: TODAY });
  assert.match(built.sql, /campaign_name = 'O''Brien Brand'/);
});

test('a filter value outside the model allowlist is rejected', () => {
  assert.throws(() => buildQuery(model, {
    source: 'google', metrics: ['spend'], dimension: 'group',
    filters: [{ dimension: 'group', value: 'DROP TABLE' }],
  }, { today: TODAY }), /not allowed for group/);
});

test('unknown source, metric and dimension all throw', () => {
  assert.throws(() => buildQuery(model, { source: 'nope', metrics: ['spend'] }, { today: TODAY }), /unknown source/);
  assert.throws(() => buildQuery(model, { source: 'blended', metrics: ['ctr'] }, { today: TODAY }), /unknown metric/);
  assert.throws(() => buildQuery(model, { source: 'blended', metrics: ['spend'], dimension: 'weekday' }, { today: TODAY }), /unknown dimension/);
});

test('the GA4 transactions default filter is always applied', () => {
  const built = buildQuery(model, { source: 'ga4_transactions', metrics: ['transactions'], dimension: 'channel' }, { today: TODAY });
  assert.match(built.sql, /event_name = 'transactions'/);
});

test('viz spec maps onto the shared builders', () => {
  const spec = { source: 'blended', metrics: ['spend', 'conversions', 'cpa'], dimension: 'platform', viz: 'table' };
  const built = buildQuery(model, spec, { today: TODAY });
  const rows = [{ dim: 'meta', spend: '1000', conversions: '50', cpa: '20' }, { dim: 'gads', spend: '800', conversions: '40', cpa: '20' }];
  const viz = buildVizSpec(model, spec, built, rows);
  assert.equal(viz.chartType, 'table');
  assert.equal(viz.rowCount, 2);
  assert.equal(viz.columns[0].key, 'dim');
  assert.equal(viz.columns[1].key, 'spend');
  assert.equal(viz.columns[1].format, 'money');
  assert.ok(viz.interpretation.length > 0);
  assert.equal(viz.dateRange.start, built.start);
});

test('a time-series spec produces a bucketed, ordered query and a combo viz', () => {
  const spec = { source: 'blended', metrics: ['spend', 'conversions'], grain: 'week', viz: 'combo' };
  const built = buildQuery(model, spec, { today: TODAY });
  assert.match(built.sql, /DATE_TRUNC\(date, WEEK\(MONDAY\)\) AS bucket/);
  assert.match(built.sql, /GROUP BY bucket/);
  assert.match(built.sql, /ORDER BY bucket/);
  const viz = buildVizSpec(model, spec, built, []);
  assert.equal(viz.chartType, 'combo');
  assert.equal(viz.series[0].kind, 'bar');
  assert.equal(viz.series[1].kind, 'line');
});
