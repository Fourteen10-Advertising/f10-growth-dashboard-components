/**
 * Tests for the query-path guard (PRD US-007). Zero-dependency:
 *   node --test ask/guard.test.mjs
 * Covers single-statement enforcement, DML/DDL rejection, comment stripping,
 * mandatory LIMIT, the dataset-allowlist check on dry-run referenced tables, and
 * the prompt-injection scenario where warehouse content tries to redirect the
 * query to another client's dataset.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import guard from './guard.js';
const {
  validateSelectOnly, assertSelectOnly, ensureLimit,
  checkReferencedTables, assertReferencedTables, checkBytes,
} = guard;

const FASTCOVER_DATASETS = ['fastcover_marts', 'fastcover_reporting'];
const PROJECT = 'mcc-poc-477801';

test('a plain SELECT and a WITH ... SELECT are accepted', () => {
  assert.equal(validateSelectOnly('SELECT 1').ok, true);
  assert.equal(validateSelectOnly('WITH x AS (SELECT 1) SELECT * FROM x').ok, true);
  assert.equal(validateSelectOnly('  select spend from `p.d.t` limit 10 ; ').ok, true, 'one trailing semicolon is fine');
});

test('multi-statement queries are rejected', () => {
  assert.equal(validateSelectOnly('SELECT 1; DELETE FROM t').ok, false);
  assert.equal(validateSelectOnly("SELECT * FROM t WHERE name = 'a'; DROP TABLE t").ok, false);
});

test('DML and DDL are rejected as leaders and anywhere', () => {
  for (const q of [
    'DELETE FROM t',
    'UPDATE t SET x = 1',
    'INSERT INTO t VALUES (1)',
    'DROP TABLE t',
    'CREATE TABLE t AS SELECT 1',
    'MERGE t USING s ON t.id = s.id WHEN MATCHED THEN DELETE',
    'WITH x AS (SELECT 1) DELETE FROM t',
  ]) {
    assert.equal(validateSelectOnly(q).ok, false, `should reject: ${q}`);
  }
});

test('comments cannot hide a second statement', () => {
  // The DROP is inside a comment; after stripping, only a safe SELECT remains.
  assert.equal(validateSelectOnly('SELECT 1 -- ; DROP TABLE t').ok, true);
  assert.equal(validateSelectOnly('/* ; DELETE FROM t */ SELECT 1').ok, true);
  // But a real second statement after a comment is still caught.
  assert.equal(validateSelectOnly('SELECT 1 /* hi */ ; DELETE FROM t').ok, false);
});

test('assertSelectOnly throws with a code on unsafe SQL', () => {
  assert.throws(() => assertSelectOnly('DELETE FROM t'), (e) => e.code === 'UNSAFE_SQL');
});

test('ensureLimit appends a LIMIT only when missing', () => {
  assert.match(ensureLimit('SELECT 1', 500), /LIMIT 500$/);
  assert.equal(/LIMIT 500/.test(ensureLimit('SELECT 1 LIMIT 20', 500)), false);
  assert.match(ensureLimit('SELECT 1 LIMIT 20', 500), /LIMIT 20$/);
});

test('referenced-table check passes for the client datasets', () => {
  const refs = [{ projectId: PROJECT, datasetId: 'fastcover_marts', tableId: 'meta_campaign_daily' }];
  assert.equal(checkReferencedTables(refs, FASTCOVER_DATASETS, PROJECT).ok, true);
});

test('prompt injection cannot redirect the query to another dataset', () => {
  // Simulate the model being tricked (by a campaign name containing instructions)
  // into naming another client's dataset. The dry-run referenced-table check refuses it.
  const refs = [
    { projectId: PROJECT, datasetId: 'fastcover_marts', tableId: 'meta_campaign_daily' },
    { projectId: PROJECT, datasetId: 'bridgit_marts', tableId: 'meta_campaign_daily' },
  ];
  const res = checkReferencedTables(refs, FASTCOVER_DATASETS, PROJECT);
  assert.equal(res.ok, false);
  assert.equal(res.offending[0].datasetId, 'bridgit_marts');
  assert.throws(() => assertReferencedTables(refs, FASTCOVER_DATASETS, PROJECT), (e) => e.code === 'OUT_OF_SCOPE_TABLE');
});

test('a table in another GCP project is refused even if the dataset name matches', () => {
  const refs = [{ projectId: 'some-other-project', datasetId: 'fastcover_marts', tableId: 't' }];
  assert.equal(checkReferencedTables(refs, FASTCOVER_DATASETS, PROJECT).ok, false);
});

test('string-form table refs are parsed and checked', () => {
  assert.equal(checkReferencedTables(['mcc-poc-477801:fastcover_marts.meta_campaign_daily'], FASTCOVER_DATASETS, PROJECT).ok, true);
  assert.equal(checkReferencedTables(['mcc-poc-477801.bridgit_marts.x'], FASTCOVER_DATASETS, PROJECT).ok, false);
});

test('bytes cap check', () => {
  assert.equal(checkBytes(1000, 2000).ok, true);
  assert.equal(checkBytes(3000, 2000).ok, false);
});
