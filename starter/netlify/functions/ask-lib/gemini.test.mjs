/**
 * Tests for the Gemini prompt builders (pure parts).
 *   node --test ask-lib/gemini.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import gemini from './gemini.js';
const { buildSpecSystemPrompt, buildFallbackSqlSystemPrompt, parseJson } = gemini;

test('spec prompt lists dimension values and today', () => {
  const model = {
    client: 'x', project: 'p', datasets: ['x_marts'],
    sources: { s: { label: 'S', table: 'x_marts.t', dateColumn: 'date', dimensions: { g: { column: 'g', options: ['Brand', 'Competitor'] } }, metrics: { spend: { label: 'Spend', sql: 'SUM(spend)' } } } },
  };
  const p = buildSpecSystemPrompt(model, '2026-08-19');
  assert.match(p, /values: Brand, Competitor/);
  assert.match(p, /Today's date is 2026-08-19/);
  assert.match(p, /OMIT dateRange/);
});

test('fallback prompt lists the full warehouse schema when present', () => {
  const model = {
    client: 'x', project: 'p', location: 'l', datasets: ['x_marts'],
    sources: { s: { table: 'x_marts.t', dateColumn: 'date', metrics: { spend: { sql: 'SUM(spend)' } } } },
    warehouse: { tables: { 'x_marts.t': { columns: [{ name: 'date', type: 'DATE' }, { name: 'device', type: 'STRING' }] } } },
  };
  const p = buildFallbackSqlSystemPrompt(model, { today: '2026-08-19', defaultRange: { start: '2026-07-01', end: '2026-07-31' } });
  assert.match(p, /Allowed tables and their columns/);
  assert.match(p, /device STRING/);
  assert.match(p, /BETWEEN '2026-07-01' AND '2026-07-31'/);
});

test('fallback prompt falls back to curated tables when no warehouse', () => {
  const model = { client: 'x', project: 'p', location: 'l', datasets: ['x_marts'], sources: { s: { table: 'x_marts.t', dateColumn: 'date', metrics: { spend: { sql: 'SUM(spend)' } } } } };
  const p = buildFallbackSqlSystemPrompt(model, {});
  assert.match(p, /Allowed tables ONLY/);
});

test('parseJson tolerates code fences and prose', () => {
  assert.deepEqual(parseJson('```json\n{"curated":true}\n```'), { curated: true });
  assert.deepEqual(parseJson('Here you go: {"a":1} thanks'), { a: 1 });
  assert.equal(parseJson('no json here'), null);
});
