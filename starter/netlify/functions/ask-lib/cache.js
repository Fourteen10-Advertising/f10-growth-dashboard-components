/**
 * cache.js — a tiny in-memory TTL cache (PRD US-008).
 *
 * Identical questions asked within a short window are served from here rather
 * than re-billed to BigQuery. Netlify keeps a warm function instance alive
 * between invocations, so rapid repeats (a client re-clicking, a shared link
 * opened by several people) hit the cache. It is per-instance, not global; that
 * is enough to stop obvious re-billing and is documented as such.
 *
 * Time is injectable for testing.
 */

'use strict';

class TtlCache {
  constructor(ttlMs = 60000, max = 200) { this.ttlMs = ttlMs; this.max = max; this.map = new Map(); }

  get(key, now = Date.now()) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now - hit.at > this.ttlMs) { this.map.delete(key); return undefined; }
    // refresh recency (Map preserves insertion order)
    this.map.delete(key); this.map.set(key, hit);
    return hit.value;
  }

  set(key, value, now = Date.now()) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, at: now });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  get size() { return this.map.size; }
}

/** Stable cache key: normalized question plus the date it was resolved against. */
function keyFor(question, today) {
  return `${today}::${String(question).trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

module.exports = { TtlCache, keyFor };
