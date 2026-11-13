import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';

/**
 * Tokens: "<kind>:<uid>[@<project>]" where kind is user | anon | admin; project defaults to
 * "myapp-prod". Admin status comes from isAdmin() (stand-in for Firestore users/{uid}.is_admin).
 * uid "broken" makes the admin lookup fail. App Check tokens: "valid-app".
 */
export class FakeVerifier {
  verifyCalls = [];
  adminLookups = 0;
  revoked = new Set();

  async verifyIdToken(token, opts = {}) {
    this.verifyCalls.push({ token, checkRevoked: opts.checkRevoked });
    const [kind, rest] = token.split(':');
    const [uid, projectId = 'myapp-prod'] = (rest ?? '').split('@');
    if (!uid) throw Object.assign(new Error('bad token'), { code: 'auth/argument-error' });
    if (opts.checkRevoked && this.revoked.has(uid)) throw Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' });
    const claims = { exp: Math.floor(Date.UTC(2030, 0, 1) / 1000), email: `${uid}@example.com` };
    if (kind === 'user') return { uid, projectId, signInProvider: 'password', claims };
    if (kind === 'anon') return { uid, projectId, signInProvider: 'anonymous', claims };
    if (kind === 'admin') return { uid, projectId, signInProvider: 'password', claims: { ...claims, is_admin_for_test: true } };
    throw Object.assign(new Error('bad token'), { code: 'auth/id-token-expired' });
  }
  async verifyAppCheckToken(token) {
    if (token !== 'valid-app') throw new Error('bad app check');
  }
  async isAdmin(user) {
    this.adminLookups++;
    if (user.uid === 'broken') throw new Error('firestore unavailable');
    return user.claims.is_admin_for_test === true;
  }
}

/** Programmable stand-in for API.Bible. */
export class FakeUpstream {
  calls = [];
  responder = (url) => json(200, { data: { id: url.pathname }, meta: { fumsToken: 'tok' } });

  fetch = async (input, init) => {
    const url = new URL(String(input));
    const key = new Headers(init?.headers).get('api-key') ?? '';
    this.calls.push({ url: url.pathname + url.search, key });
    return this.responder(url, key);
  };
}

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export class Clock {
  t = Date.UTC(2026, 0, 1);
  now = () => this.t;
  advance(ms) {
    this.t += ms;
  }
}

export const BIBLE = 'de4e12af7f28f599-02';

export async function makeApp(env = {}, deps = {}) {
  const upstream = new FakeUpstream();
  const clock = new Clock();
  const config = loadConfig({ API_BIBLE_KEYS: 'key-primary-1234,key-secondary-5678', LOG_LEVEL: 'silent', ...env });
  const verifier = new FakeVerifier();
  const app = await buildApp({ config, verifier, fetch: upstream.fetch, now: clock.now, logger: false, ...deps });
  const get = (url, token = 'user:alice', headers = {}) =>
    app.inject({ method: 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { app, upstream, clock, config, get, verifier };
}
