/**
 * Holds the API.Bible keys. Keys never leave this process: they are not logged, not
 * returned to clients, and only shown masked in /admin/stats.
 *
 * Keys are used in priority order (first = primary). A key that is rate-limited (429) or
 * rejected (401) is benched for a cooldown, and the next key is tried. This supports
 * zero-downtime rotation: add the new key, deploy, revoke the old key, remove it.
 *
 * NOTE: API.Bible Terms §9.6 allow one free-tier account per entity. Multiple keys are for
 * rotation / paid-plan failover, not for stacking free quotas.
 */

export const INVALID_KEY_COOLDOWN_MS = 10 * 60_000;
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

export class KeyPool {
  keys;
  now;

  constructor(keys, now = Date.now) {
    this.now = now;
    if (keys.length === 0) throw new Error('KeyPool requires at least one API key');
    this.keys = [...new Set(keys)].map((key) => ({ key, benchedUntil: 0 }));
  }

  /** Keys currently usable, in priority order. */
  available() {
    const t = this.now();
    return this.keys.filter((k) => k.benchedUntil <= t).map((k) => k.key);
  }

  /** Milliseconds until the next benched key becomes usable again. */
  msUntilNextAvailable() {
    const t = this.now();
    return Math.max(0, Math.min(...this.keys.map((k) => k.benchedUntil - t)));
  }

  bench(key, ms, reason) {
    const s = this.keys.find((k) => k.key === key);
    if (!s) return;
    s.benchedUntil = Math.max(s.benchedUntil, this.now() + ms);
    s.lastError = reason;
  }

  /** Safe-to-expose view (keys masked). */
  status() {
    const t = this.now();
    return this.keys.map((k, i) => ({
      index: i,
      key: mask(k.key),
      available: k.benchedUntil <= t,
      benchedForSeconds: Math.max(0, Math.ceil((k.benchedUntil - t) / 1000)),
      lastError: k.lastError,
    }));
  }
}

export function mask(key) {
  return key.length <= 8 ? '****' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}
