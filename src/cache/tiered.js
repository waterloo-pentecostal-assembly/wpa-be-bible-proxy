/**
 * L1 (in-process memory) in front of an optional shared L2 (Redis).
 * L2 failures are logged and treated as misses — the cache must never take the service down.
 */
export class TieredStore {
  name;

  l1;
  l2;
  log;

  constructor(l1, l2, log) {
    this.l1 = l1;
    this.l2 = l2;
    this.log = log;
    this.name = l2 ? `${l1.name}+${l2.name}` : l1.name;
  }

  async get(key) {
    const hit = await this.l1.get(key);
    if (hit || !this.l2) return hit;
    try {
      const shared = await this.l2.get(key);
      if (shared) await this.l1.set(key, shared);
      return shared;
    } catch (err) {
      this.log.warn({ err, tier: this.l2.name }, 'cache get failed');
      return undefined;
    }
  }

  async set(key, entry) {
    await this.l1.set(key, entry);
    if (!this.l2) return;
    try {
      await this.l2.set(key, entry);
    } catch (err) {
      this.log.warn({ err, tier: this.l2.name }, 'cache set failed');
    }
  }

  async deleteByPrefix(prefixes) {
    const local = await this.l1.deleteByPrefix(prefixes);
    // Purges must be reliable (API.Bible removal requests): let L2 errors propagate.
    return this.l2 ? Math.max(local, await this.l2.deleteByPrefix(prefixes)) : local;
  }

  async clear() {
    const local = await this.l1.clear();
    return this.l2 ? Math.max(local, await this.l2.clear()) : local;
  }

  async close() {
    await Promise.all([this.l1.close(), this.l2?.close()]);
  }
}
