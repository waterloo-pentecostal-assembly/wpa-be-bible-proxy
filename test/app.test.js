import { afterEach, describe, expect, it } from 'vitest';
import { BIBLE, json, makeApp } from './helpers.js';

const DAY = 24 * 3600 * 1000;
const VERSE = `/v1/bibles/${BIBLE}/verses/GEN.1.1`;

let ctx;
afterEach(async () => ctx?.app.close());

describe('authentication', () => {
  it('rejects missing, malformed and invalid tokens', async () => {
    ctx = await makeApp();
    for (const token of [null, 'garbage', 'expired:bob']) {
      const res = await ctx.get(VERSE, token);
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    }
    const noScheme = await ctx.app.inject({ url: VERSE, headers: { authorization: 'user:alice' } });
    expect(noScheme.statusCode).toBe(401);
    expect(ctx.upstream.calls).toHaveLength(0);
  });

  it('rejects anonymous users by default, allows them when configured', async () => {
    ctx = await makeApp();
    expect((await ctx.get(VERSE, 'anon:x')).statusCode).toBe(403);
    await ctx.app.close();
    ctx = await makeApp({ ALLOW_ANONYMOUS_USERS: 'true' });
    expect((await ctx.get(VERSE, 'anon:x')).statusCode).toBe(200);
  });

  it('enforces App Check when required', async () => {
    ctx = await makeApp({ FIREBASE_REQUIRE_APP_CHECK: 'true' });
    expect((await ctx.get(VERSE)).statusCode).toBe(401);
    expect((await ctx.get(VERSE, 'user:alice', { 'x-firebase-appcheck': 'forged' })).statusCode).toBe(401);
    expect((await ctx.get(VERSE, 'user:alice', { 'x-firebase-appcheck': 'valid-app' })).statusCode).toBe(200);
  });

  it('leaves health checks public', async () => {
    ctx = await makeApp();
    expect((await ctx.get('/healthz', null)).statusCode).toBe(200);
    expect((await ctx.get('/readyz', null)).statusCode).toBe(200);
  });
});

describe('caching', () => {
  it('fetches once, then serves from cache byte-for-byte, never exposing the key', async () => {
    ctx = await makeApp();
    const upstreamBody = JSON.stringify({ data: { id: 'GEN.1.1', content: 'In the beginning…' }, meta: { fumsToken: 'abc' } });
    ctx.upstream.responder = () => new Response(upstreamBody, { status: 200 });

    const first = await ctx.get(`${VERSE}?content-type=text`);
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-cache']).toBe('MISS');
    expect(first.body).toBe(upstreamBody);

    const second = await ctx.get(`${VERSE}?content-type=text`, 'user:bob');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toBe(upstreamBody);
    expect(second.headers['cache-control']).toBe('private, max-age=3600');

    expect(ctx.upstream.calls).toEqual([
      { url: `/v1/bibles/${BIBLE}/verses/GEN.1.1?content-type=text`, key: 'key-primary-1234' },
    ]);
    expect(JSON.stringify(second.headers) + second.body).not.toContain('key-primary');
  });

  it('canonicalises query strings so equivalent requests share an entry', async () => {
    ctx = await makeApp();
    await ctx.get(`${VERSE}?include-titles=true&content-type=text`);
    const res = await ctx.get(`${VERSE}?content-type=text&include-titles=true`);
    expect(res.headers['x-cache']).toBe('HIT');
    await ctx.get(`/v1/bibles/${BIBLE}/search?query=${encodeURIComponent('  love   one another ')}`);
    expect((await ctx.get(`/v1/bibles/${BIBLE}/search?query=love+one+another`)).headers['x-cache']).toBe('HIT');
    expect(ctx.upstream.calls.map((c) => c.url)).toEqual([
      `/v1/bibles/${BIBLE}/verses/GEN.1.1?content-type=text&include-titles=true`,
      `/v1/bibles/${BIBLE}/search?query=love+one+another`,
    ]);
  });

  it('rejects cache-busting and malformed input without calling upstream', async () => {
    ctx = await makeApp();
    expect((await ctx.get(`${VERSE}?nonce=123`)).statusCode).toBe(400);
    expect((await ctx.get(`${VERSE}?content-type=text&content-type=html`)).statusCode).toBe(400);
    expect((await ctx.get(`${VERSE}?content-type=${'x'.repeat(300)}`)).statusCode).toBe(400);
    expect([400, 404]).toContain((await ctx.get(`/v1/bibles/${BIBLE}/verses/%2E%2E`)).statusCode);
    expect((await ctx.get(`/v1/bibles/${BIBLE}/verses/GEN.1.1%2F..%2F..%2Fkeys`)).statusCode).toBe(400);
    expect((await ctx.get(`/v1/bibles/bad%24id/verses/GEN.1.1`)).statusCode).toBe(400);
    expect((await ctx.get(`/v1/bibles/${BIBLE}/unknown`)).statusCode).toBe(404);
    expect(ctx.upstream.calls).toHaveLength(0);
  });

  it('coalesces concurrent misses into one upstream call', async () => {
    ctx = await makeApp();
    let release;
    const gate = new Promise((r) => (release = r));
    ctx.upstream.responder = async () => {
      await gate;
      return json(200, { data: 'x' });
    };
    const pending = Array.from({ length: 20 }, (_, i) => ctx.get(VERSE, `user:u${i}`));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await Promise.all(pending);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(ctx.upstream.calls).toHaveLength(1);
  });

  it('refetches after the fresh TTL and serves stale when API.Bible is down', async () => {
    ctx = await makeApp();
    await ctx.get(VERSE);
    ctx.clock.advance(8 * DAY); // content TTL is 7 days
    ctx.upstream.responder = () => json(500, { error: 'boom' });
    const stale = await ctx.get(VERSE);
    expect(stale.statusCode).toBe(200);
    expect(stale.headers['x-cache']).toBe('STALE');
    expect(stale.headers['cache-control']).toBe('private, no-cache');

    ctx.upstream.responder = () => json(200, { data: 'v2' });
    const fresh = await ctx.get(VERSE);
    expect(fresh.headers['x-cache']).toBe('MISS');
    expect(JSON.parse(fresh.body)).toEqual({ data: 'v2' });
  });

  it('never serves content older than the 30-day terms ceiling', async () => {
    ctx = await makeApp();
    await ctx.get(VERSE);
    ctx.clock.advance(30 * DAY);
    ctx.upstream.responder = () => {
      throw new TypeError('fetch failed');
    };
    const res = await ctx.get(VERSE);
    expect(res.statusCode).toBe(502);
  });

  it('caches negative (404) responses briefly', async () => {
    ctx = await makeApp();
    ctx.upstream.responder = () => json(404, { statusCode: 404, error: 'Not Found', message: 'verse not found' });
    expect((await ctx.get(VERSE)).statusCode).toBe(404);
    const again = await ctx.get(VERSE);
    expect(again.statusCode).toBe(404);
    expect(again.headers['x-cache']).toBe('HIT');
    expect(ctx.upstream.calls).toHaveLength(1);
    ctx.clock.advance(11 * 60_000);
    await ctx.get(VERSE);
    expect(ctx.upstream.calls).toHaveLength(2);
  });

  it('supports conditional requests with ETag', async () => {
    ctx = await makeApp();
    const first = await ctx.get(VERSE);
    const etag = first.headers.etag;
    expect(etag).toMatch(/^"/);
    const res = await ctx.get(VERSE, 'user:alice', { 'if-none-match': etag });
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe('');
  });

  it('caps audio entries at the signed URL expiry', async () => {
    ctx = await makeApp();
    const url = '/v1/audio-bibles/105a06b6146d11e7-01/chapters/GEN.1';
    ctx.upstream.responder = () =>
      json(200, { data: { resourceUrl: 'https://cdn/x.mp3', expiresAt: Math.floor((ctx.clock.t + 3600_000) / 1000) } });
    await ctx.get(url);
    ctx.clock.advance(30 * 60_000);
    expect((await ctx.get(url)).headers['x-cache']).toBe('HIT');
    ctx.clock.advance(30 * 60_000);
    expect((await ctx.get(url)).headers['x-cache']).toBe('MISS');
  });
});

describe('API key management', () => {
  it('fails over to the next key on 401 and benches the bad key', async () => {
    ctx = await makeApp();
    ctx.upstream.responder = (_u, key) => (key === 'key-primary-1234' ? json(401, {}) : json(200, { data: 1 }));
    expect((await ctx.get(VERSE)).statusCode).toBe(200);
    await ctx.get(`/v1/bibles/${BIBLE}/verses/GEN.1.2`);
    expect(ctx.upstream.calls.map((c) => c.key)).toEqual(['key-primary-1234', 'key-secondary-5678', 'key-secondary-5678']);
  });

  it('returns 503 with Retry-After when every key is rate limited', async () => {
    ctx = await makeApp();
    ctx.upstream.responder = () => json(429, {}, { 'retry-after': '120' });
    const res = await ctx.get(VERSE);
    expect(res.statusCode).toBe(503);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(119);
    expect(JSON.stringify(res.json())).not.toContain('key-');
    // Benched: no further upstream calls until cooldown expires.
    await ctx.get(`/v1/bibles/${BIBLE}/verses/GEN.1.2`);
    expect(ctx.upstream.calls).toHaveLength(2);
  });

  it('tries other keys on 403, returns 403 if none is licensed', async () => {
    ctx = await makeApp();
    ctx.upstream.responder = () => json(403, { statusCode: 403, error: 'Forbidden', message: 'not licensed' });
    const res = await ctx.get(VERSE);
    expect(res.statusCode).toBe(403);
    expect(ctx.upstream.calls).toHaveLength(2);
  });
});

describe('rate limiting', () => {
  it('limits uncached requests per user but still serves cache hits', async () => {
    ctx = await makeApp({ RATE_LIMIT_UPSTREAM_PER_MINUTE: '2' });
    await ctx.get(`/v1/bibles/${BIBLE}/verses/GEN.1.1`);
    await ctx.get(`/v1/bibles/${BIBLE}/verses/GEN.1.2`);
    const blocked = await ctx.get(`/v1/bibles/${BIBLE}/verses/GEN.1.3`);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect((await ctx.get(`/v1/bibles/${BIBLE}/verses/GEN.1.1`)).statusCode).toBe(200);
    expect((await ctx.get(`/v1/bibles/${BIBLE}/verses/GEN.1.3`, 'user:other')).statusCode).toBe(200);
  });

  it('keeps budgets separate for the same uid in different Firebase projects', async () => {
    ctx = await makeApp({ RATE_LIMIT_REQUESTS_PER_MINUTE: '1' });
    expect((await ctx.get(VERSE, 'user:alice@myapp-dev')).statusCode).toBe(200);
    expect((await ctx.get(VERSE, 'user:alice@myapp-prod')).statusCode).toBe(200);
    expect((await ctx.get(VERSE, 'user:alice@myapp-dev')).statusCode).toBe(429);
  });

  it('limits total requests per user', async () => {
    ctx = await makeApp({ RATE_LIMIT_REQUESTS_PER_MINUTE: '3' });
    for (let i = 0; i < 3; i++) expect((await ctx.get(VERSE)).statusCode).toBe(200);
    expect((await ctx.get(VERSE)).statusCode).toBe(429);
    ctx.clock.advance(61_000);
    expect((await ctx.get(VERSE)).statusCode).toBe(200);
  });
});

describe('admin', () => {
  it('requires an admin', async () => {
    ctx = await makeApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/cache/purge',
      headers: { authorization: 'Bearer user:alice' },
      payload: { all: true },
    });
    expect(res.statusCode).toBe(403);
    expect((await ctx.get('/admin/stats')).statusCode).toBe(403);
  });

  it('purges a single bible without touching others', async () => {
    ctx = await makeApp();
    const other = '/v1/bibles/06125adad2d5898a-01/verses/GEN.1.1';
    await ctx.get(VERSE);
    await ctx.get(other);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/cache/purge',
      headers: { authorization: 'Bearer admin:root' },
      payload: { bibleId: BIBLE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(1);
    expect((await ctx.get(VERSE)).headers['x-cache']).toBe('MISS');
    expect((await ctx.get(other)).headers['x-cache']).toBe('HIT');
  });

  it('reports stats with masked keys', async () => {
    ctx = await makeApp();
    await ctx.get(VERSE);
    await ctx.get(VERSE);
    const stats = (await ctx.get('/admin/stats', 'admin:root')).json();
    expect(stats.cache).toMatchObject({ hits: 1, misses: 1 });
    expect(stats.upstream.requests).toBe(1);
    expect(stats.upstream.keys[0].key).toBe('key-…1234');
  });
});
