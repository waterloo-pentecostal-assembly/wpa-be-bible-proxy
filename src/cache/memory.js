import { LRUCache } from 'lru-cache';

/** Process-local, size-bounded LRU. Always present as the first cache tier. */
export class MemoryStore {
  name = 'memory';
  lru;
  maxTtlMs;
  now;

  constructor(opts) {
    this.now = opts.now ?? Date.now;
    this.maxTtlMs = opts.maxTtlMs ?? Number.POSITIVE_INFINITY;
    this.lru = new LRUCache({
      maxSize: opts.maxBytes,
      // JS strings are UTF-16 internally; 2 bytes/char plus fixed overhead is a fair estimate.
      sizeCalculation: (entry, key) => (entry.body.length + key.length) * 2 + 256,
    });
  }

  async get(key) {
    const entry = this.lru.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.lru.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key, entry) {
    const ttl = Math.min(entry.expiresAt - this.now(), this.maxTtlMs);
    if (ttl <= 0) return;
    this.lru.set(key, entry, { ttl });
  }

  async deleteByPrefix(prefixes) {
    let n = 0;
    for (const key of [...this.lru.keys()]) {
      if (prefixes.some((p) => key.startsWith(p))) {
        this.lru.delete(key);
        n++;
      }
    }
    return n;
  }

  async clear() {
    const n = this.lru.size;
    this.lru.clear();
    return n;
  }

  async close() {}

  get size() {
    return this.lru.size;
  }
}
