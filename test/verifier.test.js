/** Exercises the real firebase-admin SDK (no credentials needed) to check per-project routing. */
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { afterAll, describe, expect, it } from 'vitest';
import { AuthError, FirebaseVerifier, projectIdFromToken } from '../src/auth.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** Structurally valid but unsigned token: firebase-admin checks `aud` before the signature. */
const forged = (aud) =>
  `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ aud, iss: `https://securetoken.google.com/${aud}`, sub: 'u1', iat: 1, exp: 9999999999 })}.c2ln`;

const suffix = `${process.pid}-${Date.now()}`;
const apps = [
  initializeApp({ projectId: 'myapp-dev' }, `dev-${suffix}`),
  initializeApp({ projectId: 'myapp-prod' }, `prod-${suffix}`),
];
afterAll(() => Promise.all(apps.map(deleteApp)));

describe('FirebaseVerifier', () => {
  const verifier = new FirebaseVerifier(apps, false);

  it('reads the audience for routing', () => {
    expect(projectIdFromToken(forged('myapp-dev'))).toBe('myapp-dev');
    expect(projectIdFromToken('not-a-jwt')).toBeUndefined();
    expect(projectIdFromToken('a.!!!.c')).toBeUndefined();
  });

  it('rejects tokens from projects that are not configured', async () => {
    const err = await verifier.verifyIdToken(forged('someone-elses-app')).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe('auth/project-not-allowed');
    expect((await verifier.verifyIdToken('garbage').catch((e) => e)).code).toBe('auth/project-not-allowed');
  });

  it.each(['myapp-dev', 'myapp-prod'])(
    'routes %s tokens to that project (and still rejects the forged signature)',
    async (project) => {
      const err = await verifier.verifyIdToken(forged(project)).catch((e) => e);
      expect(err.code).toBe('auth/argument-error');
      // A wrong routing would fail with: incorrect "aud" (audience) claim.
      expect(err.message).not.toMatch(/incorrect "aud"/);
    },
    15_000,
  );

  it('requires explicit project ids when given several apps', () => {
    expect(() => new FirebaseVerifier([apps[0], { name: 'x', options: {} }], false)).toThrow(/explicit projectId/);
  });
});
