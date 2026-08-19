/**
 * ratelimit.js — per-site sliding-window rate limiter (PRD US-008).
 *
 * Rejects abusive request volumes with a clear message. Keyed by caller IP within
 * a warm function instance. Like the cache this is per-instance, so it is a guard
 * against a single abusive client, not a hard global quota; the maximumBytesBilled
 * cap and the scoped SA remain the hard cost/data backstops.
 *
 * Time is injectable for testing.
 */

'use strict';

class SlidingWindow {
  constructor(limit = 30, windowMs = 60000) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }

  /** Returns { allowed, remaining, retryAfterMs }. Records the hit when allowed. */
  check(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      const retryAfterMs = this.windowMs - (now - arr[0]);
      this.hits.set(key, arr);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, retryAfterMs) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    // opportunistic cleanup so the map does not grow unbounded
    if (this.hits.size > 5000) for (const [k, v] of this.hits) { if (!v.some(t => now - t < this.windowMs)) this.hits.delete(k); }
    return { allowed: true, remaining: this.limit - arr.length, retryAfterMs: 0 };
  }
}

/** Best-effort caller key from a Netlify event. */
function clientKey(event) {
  const h = (event && event.headers) || {};
  return h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
}

module.exports = { SlidingWindow, clientKey };
