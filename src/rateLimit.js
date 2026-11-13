/** Fixed-window counters keyed by an arbitrary string (we use the Firebase uid). */

export class MemoryRateLimiter {
  windows = new Map();
  lastSweep = 0;
  now;

  constructor(now = Date.now) {
    this.now = now;
  }

  async hit(key, limit, windowMs = 60_000) {
    const t = this.now();
    this.sweep(t, windowMs);
    let w = this.windows.get(key);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    return {
      allowed: w.count <= limit,
      retryAfterSec: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)),
    };
  }

  sweep(t, windowMs) {
    if (t - this.lastSweep < windowMs) return;
    this.lastSweep = t;
    for (const [k, w] of this.windows) if (t - w.start >= windowMs) this.windows.delete(k);
  }
}

/** Shared across instances. Fails open (allows) if Redis is unreachable. */
export class RedisRateLimiter {
  redis;
  prefix;
  log;
  now;

  constructor(redis, prefix, log, now = Date.now) {
    this.redis = redis;
    this.prefix = prefix;
    this.log = log;
    this.now = now;
  }

  async hit(key, limit, windowMs = 60_000) {
    const t = this.now();
    const window = Math.floor(t / windowMs);
    const retryAfterSec = Math.max(1, Math.ceil(((window + 1) * windowMs - t) / 1000));
    const redisKey = `${this.prefix}rl:${key}:${window}`;
    try {
      const [[, count]] = await this.redis.multi().incr(redisKey).pexpire(redisKey, windowMs).exec();
      return { allowed: count <= limit, retryAfterSec };
    } catch (err) {
      this.log.warn({ err }, 'rate limiter unavailable; allowing request');
      return { allowed: true, retryAfterSec };
    }
  }
}
