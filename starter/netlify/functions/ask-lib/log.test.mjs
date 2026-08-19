/**
 * Tests for the BigQuery question log (PRD US-008). buildLogRow is pure, so it
 * is unit-tested directly; the network insert (insertLog) is not exercised here.
 *   node --test ask-lib/log.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import log from './log.js';
const { buildLogRow } = log;

test('buildLogRow carries the error field and a failure outcome', () => {
  const row = buildLogRow({
    client: 'fastcover', question: 'chart cpa vs impression share', path: 'fallback-sql',
    sql: 'SELECT 1', outcome: 'cannot_answer', error: 'Unrecognized name: search_top_impression_share',
  });
  assert.equal(row.outcome, 'cannot_answer');
  assert.equal(row.error, 'Unrecognized name: search_top_impression_share');
  assert.equal(row.bytes_billed, 0, 'a failed ask billed no bytes');
  assert.equal(row.row_count, 0);
});

test('buildLogRow defaults error to null and outcome to ok on success', () => {
  const row = buildLogRow({ client: 'fastcover', question: 'spend by platform', bytesProcessed: 123, rowCount: 4 });
  assert.equal(row.error, null);
  assert.equal(row.outcome, 'ok');
  assert.equal(row.bytes_billed, 123);
  assert.equal(row.row_count, 4);
});

test('buildLogRow truncates a very long error to keep rows bounded', () => {
  const row = buildLogRow({ error: 'x'.repeat(5000) });
  assert.equal(row.error.length, 2000);
});
