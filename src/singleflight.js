/**
 * Collapses concurrent calls for the same key into one in-flight promise, so a burst of
 * clients requesting the same uncached verse costs exactly one API.Bible call.
 * (Per process. With Redis, other instances may each fetch once — still bounded.)
 */
export class SingleFlight {
  inflight = new Map();

  has(key) {
    return this.inflight.has(key);
  }

  do(key, fn) {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
