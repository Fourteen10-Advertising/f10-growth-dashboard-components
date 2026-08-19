/**
 * Tests for the US-008 cost/rate controls: cache, rate limiter, and log-row
 * shaping. Zero-dependency, time injected for determinism.
 *   node --test ask-lib/controls.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import cacheMod from './cache.js';
import rlMod from './ratelimit.js';
import logMod from './log.js';

const { TtlCache, keyFor } = cacheMod;
const { SlidingWindow, clientKey } = rlMod;
const { buildLogRow, makeLogger } = logMod;

test('cache returns a value within TTL and expires after it', () => {
  const c = new TtlCache(1000, 10);
  c.set('k', { a: 1 }, 0);
  assert.deepEqual(c.get('k', 500), { a: 1 });
  assert.equal(c.get('k', 1500), undefined);
});

test('cache evicts oldest beyond max', () => {
  const c = new TtlCache(10000, 2);
  c.set('a', 1, 0); c.set('b', 2, 1); c.set('c', 3, 2);
  assert.equal(c.get('a', 3), undefined, 'oldest evicted');
  assert.equal(c.get('b', 3), 2);
  assert.equal(c.get('c', 3), 3);
});

test('cache key normalizes whitespace, case and date', () => {
  assert.equal(keyFor('  Spend  BY   Platform ', '2026-08-19'), '2026-08-19::spend by platform');
});

test('rate limiter allows up to the limit then rejects, and recovers after the window', () => {
  const rl = new SlidingWindow(3, 1000);
  assert.equal(rl.check('ip', 0).allowed, true);
  assert.equal(rl.check('ip', 100).allowed, true);
  assert.equal(rl.check('ip', 200).allowed, true);
  const blocked = rl.check('ip', 300);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  // after the first hit ages out of the window
  assert.equal(rl.check('ip', 1100).allowed, true);
});

test('rate limiter is per key', () => {
  const rl = new SlidingWindow(1, 1000);
  assert.equal(rl.check('a', 0).allowed, true);
  assert.equal(rl.check('b', 0).allowed, true);
  assert.equal(rl.check('a', 0).allowed, false);
});

test('clientKey reads common proxy headers', () => {
  assert.equal(clientKey({ headers: { 'x-nf-client-connection-ip': '1.2.3.4' } }), '1.2.3.4');
  assert.equal(clientKey({ headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' } }), '9.9.9.9');
  assert.equal(clientKey({ headers: {} }), 'anon');
});

test('buildLogRow shapes and truncates fields', () => {
  const row = buildLogRow({
    client: 'fastcover', question: 'x'.repeat(3000), path: 'curated-deterministic',
    sql: 'y'.repeat(9000), bytesProcessed: '12345', rowCount: 3, latencyMs: 42, outcome: 'ok', ts: '2026-08-19T00:00:00Z',
  });
  assert.equal(row.client, 'fastcover');
  assert.equal(row.question.length, 2000);
  assert.equal(row.sql.length, 8000);
  assert.equal(row.bytes_billed, 12345);
  assert.equal(row.row_count, 3);
  assert.equal(row.outcome, 'ok');
  assert.equal(row.ts, '2026-08-19T00:00:00Z');
});

test('makeLogger is disabled (null) when no table is configured', () => {
  assert.equal(makeLogger({ project: 'p', token: 't', table: '', client: 'c' }), null);
  assert.equal(typeof makeLogger({ project: 'p', token: 't', table: 'ops.log', client: 'c' }), 'function');
});
