/**
 * guard.js — query-path hardening for the Ask function (PRD US-007).
 *
 * The scoped per-client service account is the backstop; this module is the
 * mechanism. It fails closed on anything ambiguous. It is used by the ask
 * function for BOTH the curated path and the guarded text-to-SQL fallback, and
 * it is re-run server-side by the "add to my dashboard" issue function on any
 * SQL it receives, so a tampered payload cannot smuggle a query past validation.
 *
 * What it enforces:
 *   1. A single statement only. Multi-statement, DML and DDL are rejected before
 *      execution. Comments are stripped first so nothing can hide inside them.
 *   2. A mandatory row LIMIT on every executed query.
 *   3. After a dry-run, every referenced table must sit in the client's dataset
 *      allowlist and in the F10 project. A query that touches another dataset is
 *      refused. This is the line that neutralises prompt injection: even if
 *      warehouse content tricked the model into naming another client's dataset,
 *      the dry-run's referenced-table check refuses it.
 *   4. A hard maximumBytesBilled cap (enforced by BigQuery, echoed here).
 *
 * CommonJS, dependency-free, so the Netlify function requires it and node --test
 * imports it with no build step.
 */

'use strict';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // ~2 GB
const DEFAULT_MAX_ROWS = 1000;

// Leading keywords that mark a statement we never execute.
const FORBIDDEN_LEADERS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'DROP', 'CREATE', 'ALTER',
  'GRANT', 'REVOKE', 'CALL', 'EXPORT', 'LOAD', 'BEGIN', 'DECLARE', 'SET', 'EXECUTE',
];
// Keywords that must never appear anywhere in a read-only query (DML/DDL verbs
// that a nested or trailing statement could use). CREATE/DROP/etc. caught here too.
const FORBIDDEN_ANYWHERE = [
  'INSERT INTO', 'DELETE FROM', 'UPDATE ', 'MERGE ', 'DROP ', 'TRUNCATE ',
  'ALTER ', 'CREATE ', 'GRANT ', 'REVOKE ', 'CALL ', 'EXPORT DATA', 'EXECUTE IMMEDIATE',
];

/** Remove -- line comments and block comments so hidden statements cannot hide. */
function stripComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/--[^\n\r]*/g, ' ')          // line comments
    .replace(/#[^\n\r]*/g, ' ');          // BigQuery # line comments
}

/** Collapse whitespace and drop a single trailing semicolon. */
function normalize(sql) {
  let s = stripComments(sql).replace(/\s+/g, ' ').trim();
  s = s.replace(/;\s*$/, '').trim(); // one trailing semicolon is fine; strip it
  return s;
}

/**
 * Validate a single read-only statement. Returns { ok, reason }.
 * Rejects: empty, multi-statement (any interior semicolon), non-SELECT/WITH
 * leader, and any forbidden DML/DDL verb anywhere in the text.
 */
function validateSelectOnly(sql) {
  const s = normalize(sql);
  if (!s) return { ok: false, reason: 'empty query' };
  if (s.includes(';')) return { ok: false, reason: 'multiple statements are not allowed' };

  const upper = s.toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    return { ok: false, reason: 'only a single SELECT or WITH query is permitted' };
  }
  for (const kw of FORBIDDEN_ANYWHERE) {
    if (upper.includes(kw)) return { ok: false, reason: `forbidden keyword: ${kw.trim()}` };
  }
  // Defence in depth: a WITH ... AS ( ... ) that then runs a DML leader.
  for (const lead of FORBIDDEN_LEADERS) {
    if (new RegExp(`(^|\\()\\s*${lead}\\b`).test(upper) && lead !== 'SELECT') {
      // allow SELECT after an opening paren (subqueries); block DML/DDL leaders
      return { ok: false, reason: `forbidden statement: ${lead}` };
    }
  }
  return { ok: true, reason: null };
}

function assertSelectOnly(sql) {
  const v = validateSelectOnly(sql);
  if (!v.ok) { const e = new Error(v.reason); e.code = 'UNSAFE_SQL'; throw e; }
  return true;
}

/**
 * Ensure the query carries a row LIMIT. If the outer query already ends in a
 * LIMIT, it is left as-is (clamped by BigQuery maxResults regardless); otherwise
 * a LIMIT is appended. Curated SQL already includes one; this protects the
 * text-to-SQL fallback.
 */
function ensureLimit(sql, maxRows = DEFAULT_MAX_ROWS) {
  const s = normalize(sql);
  if (/\bLIMIT\s+\d+\s*$/i.test(s)) return s;
  return `${s}\nLIMIT ${maxRows}`;
}

/**
 * Normalise a dry-run's referenced tables into { projectId, datasetId, tableId }.
 * Accepts BigQuery's structured form or a "project.dataset.table" / "project:dataset.table" string.
 */
function normalizeTableRefs(refs) {
  return (refs || []).map(r => {
    if (r && typeof r === 'object' && r.datasetId) {
      return { projectId: r.projectId || null, datasetId: r.datasetId, tableId: r.tableId || null };
    }
    const str = String(r).replace(':', '.');
    const parts = str.split('.');
    if (parts.length >= 3) return { projectId: parts[0], datasetId: parts[1], tableId: parts.slice(2).join('.') };
    if (parts.length === 2) return { projectId: null, datasetId: parts[0], tableId: parts[1] };
    return { projectId: null, datasetId: str, tableId: null };
  });
}

/**
 * Check that every referenced table is inside the client's dataset allowlist and
 * the F10 project. Returns { ok, offending: [ref...] }.
 */
function checkReferencedTables(refs, allowedDatasets, project) {
  const norm = normalizeTableRefs(refs);
  const allow = new Set(allowedDatasets || []);
  const offending = norm.filter(t =>
    !allow.has(t.datasetId) || (project && t.projectId && t.projectId !== project));
  return { ok: offending.length === 0, offending };
}

function assertReferencedTables(refs, allowedDatasets, project) {
  const { ok, offending } = checkReferencedTables(refs, allowedDatasets, project);
  if (!ok) {
    const names = offending.map(t => [t.projectId, t.datasetId, t.tableId].filter(Boolean).join('.')).join(', ');
    const e = new Error(`query references tables outside the client's allowlist: ${names}`);
    e.code = 'OUT_OF_SCOPE_TABLE';
    throw e;
  }
  return true;
}

/** Bytes-cap check (BigQuery also enforces maximumBytesBilled; this is belt-and-braces). */
function checkBytes(estimatedBytes, maxBytes = DEFAULT_MAX_BYTES) {
  const est = Number(estimatedBytes || 0);
  return { ok: est <= maxBytes, estimatedBytes: est, maxBytes };
}

module.exports = {
  DEFAULT_MAX_BYTES, DEFAULT_MAX_ROWS,
  stripComments, normalize,
  validateSelectOnly, assertSelectOnly,
  ensureLimit,
  normalizeTableRefs, checkReferencedTables, assertReferencedTables,
  checkBytes,
};
