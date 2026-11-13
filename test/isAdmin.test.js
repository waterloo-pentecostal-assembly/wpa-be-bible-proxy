/** FirebaseVerifier.isAdmin against a mocked Firestore `users` collection. */
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { afterAll, describe, expect, it, vi } from 'vitest';

const profiles = new Map(); // `${projectId}/${docId}` -> data
const queried = [];

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: (app) => {
    const project = app.options.projectId;
    const snap = (data) => ({ exists: !!data, get: (f) => data?.[f] });
    return {
      collection: (name) => ({
        doc: (id) => ({ get: async () => snap(profiles.get(`${project}/${name}/${id}`)) }),
        where: (field, _op, value) => ({
          get: async () => {
            queried.push(`${project}:${field}=${value}`);
            const docs = [...profiles.entries()]
              .filter(([k, d]) => k.startsWith(`${project}/${name}/`) && d[field] === value)
              .map(([, d]) => snap(d));
            return { empty: docs.length === 0, docs };
          },
        }),
      }),
    };
  },
}));

const { FirebaseVerifier } = await import('../src/auth.js');
const suffix = `${process.pid}-${Date.now()}`;
const apps = [initializeApp({ projectId: 'myapp-dev' }, `ia-dev-${suffix}`), initializeApp({ projectId: 'myapp-prod' }, `ia-prod-${suffix}`)];
afterAll(() => Promise.all(apps.map(deleteApp)));
const verifier = new FirebaseVerifier(apps, false);

const user = (uid, projectId, claims = {}) => ({ uid, projectId, claims });

describe('FirebaseVerifier.isAdmin', () => {
  profiles.set('myapp-prod/users/admin1', { is_admin: true, email: 'a@x.org' });
  profiles.set('myapp-prod/users/user1', { is_admin: false, email: 'u@x.org' });
  profiles.set('myapp-prod/users/truthy', { is_admin: 'yes' });
  profiles.set('myapp-prod/users/legacy', { is_admin: true, email: 'legacy@x.org' });

  it('requires is_admin === true on users/{uid}', async () => {
    expect(await verifier.isAdmin(user('admin1', 'myapp-prod'))).toBe(true);
    expect(await verifier.isAdmin(user('user1', 'myapp-prod'))).toBe(false);
    expect(await verifier.isAdmin(user('truthy', 'myapp-prod'))).toBe(false);
  });

  it('looks in the project that issued the token', async () => {
    expect(await verifier.isAdmin(user('admin1', 'myapp-dev'))).toBe(false);
    expect(await verifier.isAdmin(user('admin1', 'unknown-project'))).toBe(false);
  });

  it('falls back to the email profile only for verified emails', async () => {
    const claims = { email: 'legacy@x.org' };
    expect(await verifier.isAdmin(user('new-uid', 'myapp-prod', { ...claims, email_verified: false }))).toBe(false);
    expect(queried).toHaveLength(0);
    expect(await verifier.isAdmin(user('new-uid', 'myapp-prod', { ...claims, email_verified: true }))).toBe(true);
    expect(queried).toEqual(['myapp-prod:email=legacy@x.org']);
  });

  it('accepts any matching email profile that is an admin (like wpa-be-admin)', async () => {
    profiles.set('myapp-prod/users/dup-a', { is_admin: false, email: 'dup@x.org' });
    profiles.set('myapp-prod/users/dup-b', { is_admin: true, email: 'dup@x.org' });
    expect(await verifier.isAdmin(user('fresh-uid', 'myapp-prod', { email: 'dup@x.org', email_verified: true }))).toBe(true);
  });

  it('does not fall back when a uid profile exists (even if it is not admin)', async () => {
    profiles.set('myapp-prod/users/user2', { is_admin: false, email: 'legacy@x.org' });
    queried.length = 0;
    expect(await verifier.isAdmin(user('user2', 'myapp-prod', { email: 'legacy@x.org', email_verified: true }))).toBe(false);
    expect(queried).toHaveLength(0);
  });
});
