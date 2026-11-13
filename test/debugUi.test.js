import { afterEach, describe, expect, it } from 'vitest';
import { ROUTES } from '../src/routes.js';
import { makeApp } from './helpers.js';

let ctx;
afterEach(async () => ctx?.app.close());

describe('debug console', () => {
  it('serves only static assets publicly, with a strict CSP', async () => {
    ctx = await makeApp();
    expect((await ctx.get('/debug', null)).headers.location).toBe('/debug/');

    const page = await ctx.get('/debug/', null);
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['referrer-policy']).toBe('strict-origin');
    expect(page.body).toContain('/debug/app.js');

    expect((await ctx.get('/debug/app.js', null)).headers['content-type']).toMatch(/^text\/javascript/);
    expect((await ctx.get('/debug/app.css', null)).headers['content-type']).toMatch(/^text\/css/);
    expect((await ctx.get('/debug/../src/config.js', null)).statusCode).toBe(404);
    expect((await ctx.get('/debug/nope.js', null)).statusCode).toBe(404);
  });

  it('publishes the Firebase web config before sign-in', async () => {
    ctx = await makeApp();
    expect((await ctx.get('/debug/firebase-config', null)).json()).toEqual({ projects: [] });
    await ctx.app.close();

    const cfg = [{ apiKey: 'AIza-dev', projectId: 'myapp-dev' }, { apiKey: 'AIza-prod', projectId: 'myapp-prod', authDomain: 'p.firebaseapp.com' }];
    ctx = await makeApp({}, { firebaseClientConfigs: cfg });
    const res = await ctx.get('/debug/firebase-config', null);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json().projects.map((p) => p.projectId)).toEqual(['myapp-dev', 'myapp-prod']);
  });

  it('loads its data only through admin endpoints', async () => {
    ctx = await makeApp();
    expect((await ctx.get('/admin/routes', null)).statusCode).toBe(401);
    expect((await ctx.get('/admin/routes', 'user:alice')).statusCode).toBe(403);
    expect((await ctx.get('/admin/routes', 'admin:root')).json()).toEqual(JSON.parse(JSON.stringify(ROUTES)));
  });
});
