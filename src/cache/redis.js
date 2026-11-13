import { Redis } from 'ioredis';

/** Shared tier so all proxy instances share one cache (and one upstream fetch per key). */
export class RedisStore {
  name = 'redis';

  redis;
  prefix;
  now;

  constructor(redis, prefix, now = Date.now) {
    this.redis = redis;
    this.prefix = prefix;
    this.now = now;
  }

  static connect(url, prefix, now = Date.now) {
    const redis = new Redis(url, {
      // Fail fast rather than queueing: a cache outage must not stall requests.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
      commandTimeout: 1_000,
    });
    // Errors are surfaced per-command; avoid unhandled 'error' event crashes.
    redis.on('error', () => {});
    return new RedisStore(redis, prefix, now);
  }

  /** Resolve once connected (or after timeout); commands fail fast until then. */
  async waitReady(timeoutMs) {
    if (this.redis.status === 'ready') return true;
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(timer);
        this.redis.off('ready', onReady);
        resolve(ok);
      };
      const onReady = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.redis.once('ready', onReady);
    });
  }

  get client() {
    return this.redis;
  }

  async get(key) {
    const raw = await this.redis.get(this.prefix + key);
    if (!raw) return undefined;
    const entry = JSON.parse(raw);
    return entry.expiresAt > this.now() ? entry : undefined;
  }

  async set(key, entry) {
    const ttl = entry.expiresAt - this.now();
    if (ttl <= 0) return;
    await this.redis.set(this.prefix + key, JSON.stringify(entry), 'PX', ttl);
  }

  async deleteByPrefix(prefixes) {
    let n = 0;
    for (const p of prefixes) n += await this.scanDelete(this.prefix + escapeGlob(p) + '*');
    return n;
  }

  async clear() {
    return this.scanDelete(escapeGlob(this.prefix) + '*');
  }

  async scanDelete(pattern) {
    let cursor = '0';
    let n = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length) n += await this.redis.unlink(...keys);
    } while (cursor !== '0');
    return n;
  }

  async close() {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

function escapeGlob(s) {
  return s.replace(/[*?[\]\\]/g, '\\$&');
}
