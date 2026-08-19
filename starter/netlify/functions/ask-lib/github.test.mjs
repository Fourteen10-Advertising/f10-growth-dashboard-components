/**
 * Tests for the GitHub helper's pure parts (PRD US-010):
 *   node --test ask-lib/github.test.mjs
 * Covers fingerprint stability, issue title/body building, the preview table, and
 * a real app JWT signed with an ephemeral RSA key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import github from './github.js';
const { fingerprint, buildIssueTitle, buildIssueBody, previewTable, appJwt } = github;

test('fingerprint is stable and whitespace/case-insensitive', () => {
  const a = fingerprint('Spend by platform', 'SELECT 1');
  const b = fingerprint('  spend   by PLATFORM ', 'SELECT   1');
  assert.equal(a, b);
  assert.notEqual(a, fingerprint('spend by channel', 'SELECT 1'));
  assert.equal(a.length, 16);
});

test('issue title truncates long questions', () => {
  assert.equal(buildIssueTitle('spend by platform'), 'Ask request: spend by platform');
  const long = buildIssueTitle('a'.repeat(200));
  assert.ok(long.length <= 'Ask request: '.length + 80);
  assert.ok(long.endsWith('...'));
});

test('issue body embeds the question, SQL, fingerprint marker and a preview', () => {
  const vizSpec = {
    chartType: 'table', title: 'Spend by platform', dateRange: { start: '2026-07-01', end: '2026-07-31' }, rowCount: 2,
    columns: [{ label: 'Platform', key: 'dim' }, { label: 'Spend', key: 'spend' }],
    rows: [{ dim: 'meta', spend: '48210' }, { dim: 'gads', spend: '31980' }],
  };
  const body = buildIssueBody({ question: 'spend by platform', sql: 'SELECT dim, SUM(spend) FROM t', vizSpec, client: 'fastcover', datasets: ['fastcover_marts', 'fastcover_reporting'], fp: 'abc123' });
  assert.match(body, /spend by platform/);
  assert.match(body, /SELECT dim, SUM\(spend\) FROM t/);
  assert.match(body, /<!-- ask-fingerprint: abc123 -->/);
  assert.match(body, /fastcover_marts, fastcover_reporting/);
  assert.match(body, /\| Platform \| Spend \|/);
  assert.match(body, /\| meta \| 48210 \|/);
});

test('preview table handles empty rows', () => {
  assert.match(previewTable({ rows: [] }), /No rows/);
});

test('appJwt produces a valid RS256 JWT signed by the app private key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const jwt = appJwt('12345', pem, 1_700_000_000);
  const [h, p, s] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(payload.iss, '12345');
  assert.ok(payload.exp - payload.iat <= 600, 'app JWT lives at most 10 minutes');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'));
  assert.equal(ok, true);
});
