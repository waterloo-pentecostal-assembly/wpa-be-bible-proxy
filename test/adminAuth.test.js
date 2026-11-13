import { afterEach, describe, expect, it } from 'vitest';
import { BIBLE, makeApp } from './helpers.js';

const VERSE = `/v1/bibles/${BIBLE}/verses/JHN.3.16`;
let ctx;
afterEach(async () => ctx?.app.close());

describe('admin auth (Firestore users/{uid}.is_admin)', () => {
  it('returns 401 / 403 / 503 like wpa-be-admin', async () => {
    ctx = await makeApp();
    expect((await ctx.get('/admin/whoami', null)).statusCode).toBe(401);
    expect((await ctx.get('/admin/whoami', 'garbage')).statusCode).toBe(401);
    const nonAdmin = await ctx.get('/admin/whoami', 'user:alice');
    expect(nonAdmin.statusCode).toBe(403);
    expect(nonAdmin.json().message).toBe('Admin access required.');
    expect((await ctx.get('/admin/whoami', 'admin:broken')).statusCode).toBe(503);
  });

  it('identifies the admin and always checks revocation', async () => {
    ctx = await makeApp();
    const res = await ctx.get('/admin/whoami', 'admin:root@myapp-dev');
    expect(res.json()).toEqual({ uid: 'root', email: 'root@example.com', projectId: 'myapp-dev' });
    expect(ctx.verifier.verifyCalls.at(-1)?.checkRevoked).toBe(true);
  });

  it('caches a verified admin for up to a minute', async () => {
    ctx = await makeApp();
    await ctx.get('/admin/whoami', 'admin:root');
    await ctx.get('/admin/stats', 'admin:root');
    expect(ctx.verifier.adminLookups).toBe(1);

    ctx.verifier.revoked.add('root');
    ctx.clock.advance(61_000);
    expect((await ctx.get('/admin/whoami', 'admin:root')).statusCode).toBe(401);
    expect(ctx.verifier.adminLookups).toBe(1);
  });

  it('does not cache rejections', async () => {
    ctx = await makeApp();
    expect((await ctx.get('/admin/whoami', 'user:alice')).statusCode).toBe(403);
    expect((await ctx.get('/admin/whoami', 'user:alice')).statusCode).toBe(403);
    expect(ctx.verifier.adminLookups).toBe(2);
  });
});

describe('admin project (prod admins only; dev users still use /v1)', () => {
  it('rejects admins from other projects before the Firestore lookup', async () => {
    ctx = await makeApp({}, { adminProjectId: 'myapp-prod' });
    const dev = await ctx.get('/admin/whoami', 'admin:root@myapp-dev');
    expect(dev.statusCode).toBe(403);
    expect(dev.json().message).toBe('Admin access requires a myapp-prod account.');
    expect(ctx.verifier.adminLookups).toBe(0);
    expect((await ctx.get('/admin/whoami', 'admin:root@myapp-prod')).json().projectId).toBe('myapp-prod');
  });

  it('still serves /v1 to users of every accepted project', async () => {
    ctx = await makeApp({}, { adminProjectId: 'myapp-prod' });
    expect((await ctx.get(VERSE, 'user:alice@myapp-dev')).statusCode).toBe(200);
    expect((await ctx.get(VERSE, 'user:bob@myapp-prod')).statusCode).toBe(200);
  });
});

describe('/admin/v1 (skip client auth)', () => {
  it('lets admins call the Bible API without client-side checks', async () => {
    ctx = await makeApp({ FIREBASE_REQUIRE_APP_CHECK: 'true' });
    expect((await ctx.get(VERSE, 'admin:root')).statusCode).toBe(401); // client route: App Check required
    const res = await ctx.get(`/admin${VERSE}`, 'admin:root');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
  });

  it('shares the cache with /v1 and is still rate limited', async () => {
    ctx = await makeApp({ RATE_LIMIT_REQUESTS_PER_MINUTE: '2' });
    await ctx.get(VERSE, 'user:alice');
    expect((await ctx.get(`/admin${VERSE}`, 'admin:root')).headers['x-cache']).toBe('HIT');
    expect(ctx.upstream.calls).toHaveLength(1);
    await ctx.get(`/admin${VERSE}`, 'admin:root');
    expect((await ctx.get(`/admin${VERSE}`, 'admin:root')).statusCode).toBe(429);
  });

  it('rejects non-admins and unauthenticated callers', async () => {
    ctx = await makeApp();
    expect((await ctx.get(`/admin${VERSE}`, null)).statusCode).toBe(401);
    expect((await ctx.get(`/admin${VERSE}`, 'user:alice')).statusCode).toBe(403);
    expect((await ctx.get(`/admin/v1/bibles/${BIBLE}/verses/JHN.3.16?nonce=1`, 'admin:root')).statusCode).toBe(400);
    expect(ctx.upstream.calls).toHaveLength(0);
  });
});
