/**
 * Integration tests against a real Redis. Skipped unless TEST_REDIS_URL is set, e.g.
 *   docker run --rm -p 6379:6379 redis:7-alpine
 *   TEST_REDIS_URL=redis://localhost:6379 npm test
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RedisStore } from '../src/cache/redis.js';
import { BIBLE, makeApp } from './helpers.js';

const url = process.env.TEST_REDIS_URL;

describe.skipIf(!url)('redis tier', () => {
  const apps = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.app.close()));
  });

  async function instance() {
    const a = await makeApp({ REDIS_URL: url, REDIS_KEY_PREFIX: `test-${process.pid}:` });
    apps.push(a);
    return a;
  }

  it('shares cache entries and purges across instances', async () => {
    const a = await instance();
    const b = await instance();
    await a.get('/admin/stats', 'admin:root'); // warm
    await a.app.inject({ method: 'POST', url: '/admin/cache/purge', headers: { authorization: 'Bearer admin:root' }, payload: { all: true } });

    const verse = `/v1/bibles/${BIBLE}/verses/JHN.3.16`;
    expect((await a.get(verse)).headers['x-cache']).toBe('MISS');
    expect((await b.get(verse)).headers['x-cache']).toBe('HIT');
    expect(b.upstream.calls).toHaveLength(0);

    const purge = await b.app.inject({
      method: 'POST',
      url: '/admin/cache/purge',
      headers: { authorization: 'Bearer admin:root' },
      payload: { bibleId: BIBLE },
    });
    expect(purge.json().deleted).toBeGreaterThanOrEqual(1);
    // Instance b purged its own L1 and Redis; a's L1 copy expires within MEMORY_CACHE_MAX_TTL_SECONDS.
    expect((await b.get(verse)).headers['x-cache']).toBe('MISS');
    expect((await a.get('/readyz', null)).statusCode).toBe(200);
  });

  it('shares rate-limit counters across instances', async () => {
    const env = { REDIS_URL: url, REDIS_KEY_PREFIX: `test-rl-${process.pid}-${Date.now()}:`, RATE_LIMIT_REQUESTS_PER_MINUTE: '2' };
    const a = await makeApp(env);
    const b = await makeApp(env);
    apps.push(a, b);
    const verse = `/v1/bibles/${BIBLE}/verses/GEN.1.1`;
    expect((await a.get(verse, 'user:carol')).statusCode).toBe(200);
    expect((await b.get(verse, 'user:carol')).statusCode).toBe(200);
    expect((await a.get(verse, 'user:carol')).statusCode).toBe(429);
  });

  it('degrades to memory-only when Redis is unreachable', async () => {
    const dead = RedisStore.connect('redis://127.0.0.1:1', 'x:');
    const a = await makeApp();
    await a.app.close();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config/config.js');
    const { FakeVerifier, FakeUpstream } = await import('./helpers.js');
    const up = new FakeUpstream();
    const app = await buildApp({
      config: loadConfig({ API_BIBLE_KEYS: 'k123456789', LOG_LEVEL: 'silent' }),
      verifier: new FakeVerifier(),
      fetch: up.fetch,
      redis: dead,
      logger: false,
    });
    const res = await app.inject({ url: `/v1/bibles/${BIBLE}/verses/GEN.1.1`, headers: { authorization: 'Bearer user:a' } });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ url: '/readyz' })).statusCode).toBe(503);
    await app.close();
  }, 15_000);
});
