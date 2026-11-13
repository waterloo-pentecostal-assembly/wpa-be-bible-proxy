import { createHash } from 'node:crypto';
import { SingleFlight } from './singleflight.js';

/** Cache keys always contain "?" right after the path so prefix purges are unambiguous. */
export function cacheKey(path, query) {
  return `${path}?${query}`;
}

export class BibleProxy {
  flights = new SingleFlight();
  now;
  stats = { hits: 0, misses: 0, stale: 0, coalesced: 0, upstreamErrors: 0, userThrottled: 0 };

  opts;

  constructor(opts) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  async get(req) {
    const key = cacheKey(req.path, req.query);
    const cached = await this.opts.cache.get(key);

    if (cached && cached.freshUntil > this.now()) {
      this.stats.hits++;
      return { kind: 'entry', entry: cached, cache: 'HIT' };
    }

    // Someone is already fetching this key: wait for their result at no quota cost.
    if (this.flights.has(key)) {
      this.stats.coalesced++;
      return this.flights.do(key, () => this.refresh(key, req, cached));
    }

    // This request would cost an API.Bible call: charge the user's upstream budget.
    const budget = await this.opts.limiter.hit(`upstream:${req.uid}`, this.opts.upstreamPerMinute);
    if (!budget.allowed) {
      this.stats.userThrottled++;
      const stale = this.usableStale(cached);
      if (stale) {
        this.stats.stale++;
        return { kind: 'entry', entry: stale, cache: 'STALE' };
      }
      return {
        kind: 'error',
        status: 429,
        code: 'Too Many Requests',
        message: 'Too many uncached requests; slow down.',
        retryAfterSec: budget.retryAfterSec,
      };
    }

    return this.flights.do(key, () => this.refresh(key, req, cached));
  }

  async refresh(key, req, cached) {
    const { ttlSeconds, log } = this.opts;
    const outcome = await this.opts.upstream.get(req.query ? `${req.path}?${req.query}` : req.path);

    if (outcome.type === 'ok' || outcome.type === 'negative') {
      const fetchedAt = this.now();
      let freshMs;
      let hardMs;
      if (outcome.type === 'ok') {
        freshMs = ttlSeconds[req.cacheClass] * 1000;
        hardMs = Math.max(freshMs, this.opts.staleIfErrorSeconds * 1000);
        // Signed URLs (audio) must not outlive their own expiry.
        const exp = findExpiresAt(outcome.json);
        if (exp !== undefined) {
          const remaining = exp - fetchedAt - 60_000;
          freshMs = Math.min(freshMs, remaining);
          hardMs = Math.min(hardMs, remaining);
        }
      } else {
        freshMs = hardMs = ttlSeconds.negative * 1000;
      }
      const entry = {
        status: outcome.status,
        body: outcome.body,
        etag: etagOf(outcome.body),
        fetchedAt,
        freshUntil: fetchedAt + Math.max(0, freshMs),
        expiresAt: fetchedAt + Math.max(0, hardMs),
      };
      if (freshMs > 0) await this.opts.cache.set(key, entry);
      this.stats.misses++;
      return { kind: 'entry', entry, cache: 'MISS' };
    }

    // Upstream unavailable: serve stale content (bounded by the 30-day terms ceiling) if we have it.
    this.stats.upstreamErrors++;
    const stale = this.usableStale(cached);
    if (stale) {
      log.warn({ key, reason: outcome.reason }, 'serving stale cache entry');
      this.stats.stale++;
      return { kind: 'entry', entry: stale, cache: 'STALE' };
    }
    const noKeys = outcome.reason === 'no_api_key_available';
    return {
      kind: 'error',
      status: noKeys ? 503 : 502,
      code: noKeys ? 'Service Unavailable' : 'Bad Gateway',
      message: noKeys ? 'Bible service is temporarily over capacity.' : 'Bible service is temporarily unavailable.',
      retryAfterSec: outcome.retryAfterSec ?? (noKeys ? 60 : undefined),
    };
  }

  /** Only successful responses may be served stale, and never past their hard expiry. */
  usableStale(entry) {
    return entry && entry.status === 200 && entry.expiresAt > this.now() ? entry : undefined;
  }
}

export function etagOf(body) {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
}

/** Look for `data.expiresAt` (epoch seconds/ms or ISO date) in an API.Bible response. */
function findExpiresAt(json) {
  const data = json?.data;
  const v = data && typeof data === 'object' && !Array.isArray(data) ? data.expiresAt : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const asNum = Number(v);
    if (Number.isFinite(asNum) && v.trim() !== '') return asNum < 1e12 ? asNum * 1000 : asNum;
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}
