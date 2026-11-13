import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_DIR, loadClientConfigs, loadFirebaseSetup, loadServiceAccounts } from '../src/config/firebase.js';

const PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const sa = (projectId) => ({
  type: 'service_account',
  project_id: projectId,
  private_key_id: 'abc',
  private_key: PRIVATE_KEY,
  client_email: `firebase-adminsdk@${projectId}.iam.gserviceaccount.com`,
  client_id: '123',
});
const webConfig = (projectId) => ({ apiKey: `AIza-${projectId}`, authDomain: `${projectId}.firebaseapp.com`, projectId, appId: '1:2:web:3' });

let root;
let configDir;
let secretsDir;
const write = (dir, file, data) => writeFileSync(join(dir, file), typeof data === 'string' ? data : JSON.stringify(data));
const opts = (env = {}) => ({ env, configDir, secretsDir });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bp-fb-'));
  configDir = join(root, 'src-config');
  secretsDir = join(root, 'etc-secrets');
  mkdirSync(configDir);
  mkdirSync(secretsDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('src/config layout', () => {
  it('points at <root>/src/config', () => {
    expect(CONFIG_DIR.replace(/\/$/, '')).toMatch(/\/src\/config$/);
  });

  it('returns nothing when no files or env vars are present', () => {
    expect(loadFirebaseSetup([], opts())).toEqual({ projectIds: [], serviceAccounts: [], clientConfigs: [], sources: {} });
  });
});

describe('service accounts', () => {
  it('loads prod and dev from src/config and accepts their projects', () => {
    write(configDir, 'service-account.json', sa('myapp-prod'));
    write(configDir, 'service-account-dev.json', sa('myapp-dev'));
    const setup = loadFirebaseSetup(['legacy-project'], opts());
    expect(setup.projectIds).toEqual(['myapp-prod', 'myapp-dev', 'legacy-project']);
    expect(setup.serviceAccounts.map((a) => [a.env, a.projectId])).toEqual([['prod', 'myapp-prod'], ['dev', 'myapp-dev']]);
    expect(setup.sources).toEqual({
      'serviceAccount.prod': 'src/config/service-account.json (myapp-prod)',
      'serviceAccount.dev': 'src/config/service-account-dev.json (myapp-dev)',
    });
  });

  it('prefers /etc/secrets, then the env var, then src/config (like wpa-be-admin)', () => {
    write(configDir, 'service-account.json', sa('from-file'));
    expect(loadServiceAccounts(opts({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(sa('from-env')) }))[0]?.projectId).toBe('from-env');
    write(secretsDir, 'service-account.json', sa('from-secret'));
    expect(loadServiceAccounts(opts({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(sa('from-env')) }))[0]?.projectId).toBe('from-secret');
    expect(loadServiceAccounts(opts({ FIREBASE_SERVICE_ACCOUNT_DEV: JSON.stringify(sa('dev-env')) }))[1]?.env).toBe('dev');
  });

  it('rejects bad files without leaking their contents', () => {
    write(configDir, 'service-account.json', '{ "private_key": "-----BEGIN SECRET');
    expect(() => loadServiceAccounts(opts())).toThrow(/src\/config\/service-account.json: not valid JSON/);
    write(configDir, 'service-account.json', { project_id: 'p', private_key: 'TOP-SECRET-KEY' });
    try {
      loadServiceAccounts(opts());
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toMatch(/not a service account key \(client_email/);
      expect(String(err)).not.toContain('TOP-SECRET-KEY');
    }
  });

  it('rejects prod and dev pointing at the same project', () => {
    write(configDir, 'service-account.json', sa('same'));
    write(configDir, 'service-account-dev.json', sa('same'));
    expect(() => loadServiceAccounts(opts())).toThrow(/both for project "same"/);
  });

  it('produces JSON that firebase-admin accepts as a credential', async () => {
    write(configDir, 'service-account.json', sa('myapp-prod'));
    const [account] = loadServiceAccounts(opts());
    const app = initializeApp({ projectId: account.projectId, credential: cert(account.json) }, `cert-${process.pid}`);
    expect(app.options.projectId).toBe('myapp-prod');
    await deleteApp(app);
  });
});

describe('firebase-client-config.json', () => {
  it('accepts one web config or an array, keeping only what sign-in needs', () => {
    write(configDir, 'firebase-client-config.json', webConfig('myapp-prod'));
    expect(loadClientConfigs(opts()).configs).toEqual([{ apiKey: 'AIza-myapp-prod', authDomain: 'myapp-prod.firebaseapp.com', projectId: 'myapp-prod' }]);
    write(configDir, 'firebase-client-config.json', [webConfig('myapp-dev'), webConfig('myapp-prod')]);
    expect(loadClientConfigs(opts()).configs.map((c) => c.projectId)).toEqual(['myapp-dev', 'myapp-prod']);
  });

  it('uses the same precedence as service accounts', () => {
    write(configDir, 'firebase-client-config.json', webConfig('from-file'));
    const env = { FIREBASE_CLIENT_CONFIG: JSON.stringify(webConfig('from-env')) };
    expect(loadClientConfigs(opts(env))).toMatchObject({ source: '$FIREBASE_CLIENT_CONFIG' });
    write(secretsDir, 'firebase-client-config.json', webConfig('from-secret'));
    expect(loadClientConfigs(opts(env)).configs[0]?.projectId).toBe('from-secret');
  });

  it('must match an accepted project', () => {
    write(configDir, 'service-account.json', sa('myapp-prod'));
    write(configDir, 'firebase-client-config.json', [webConfig('myapp-prod'), webConfig('other')]);
    expect(() => loadFirebaseSetup([], opts())).toThrow(/"other" has no service account and is not in FIREBASE_PROJECT_IDS/);
    expect(loadFirebaseSetup(['other'], opts()).projectIds).toEqual(['myapp-prod', 'other']);
  });

  it('rejects malformed entries and duplicates', () => {
    write(configDir, 'firebase-client-config.json', '{oops');
    expect(() => loadClientConfigs(opts())).toThrow(/not valid JSON/);
    write(configDir, 'firebase-client-config.json', { projectId: 'x' });
    expect(() => loadClientConfigs(opts())).toThrow(/needs string "apiKey" and "projectId"/);
    write(configDir, 'firebase-client-config.json', [webConfig('a'), webConfig('a')]);
    expect(() => loadClientConfigs(opts())).toThrow(/duplicate entry for project "a"/);
  });
});

describe('admin project', () => {
  it('defaults to the prod service account and publishes only its web config to the console', () => {
    write(configDir, 'service-account.json', sa('myapp-prod'));
    write(configDir, 'service-account-dev.json', sa('myapp-dev'));
    write(configDir, 'firebase-client-config.json', [webConfig('myapp-dev'), webConfig('myapp-prod')]);
    const setup = loadFirebaseSetup([], opts());
    expect(setup.projectIds).toEqual(['myapp-prod', 'myapp-dev']); // both projects may call /v1
    expect(setup.adminProjectId).toBe('myapp-prod');
    expect(setup.clientConfigs.map((c) => c.projectId)).toEqual(['myapp-prod']);
    expect(setup.sources.clientConfig).toBe('src/config/firebase-client-config.json (myapp-prod)');
  });

  it('works with a single prod web config object', () => {
    write(configDir, 'service-account.json', sa('myapp-prod'));
    write(configDir, 'service-account-dev.json', sa('myapp-dev'));
    write(configDir, 'firebase-client-config.json', webConfig('myapp-prod'));
    expect(loadFirebaseSetup([], opts()).clientConfigs).toEqual([
      { apiKey: 'AIza-myapp-prod', authDomain: 'myapp-prod.firebaseapp.com', projectId: 'myapp-prod' },
    ]);
  });

  it('can be overridden, but must be an accepted project', () => {
    write(configDir, 'service-account.json', sa('myapp-prod'));
    write(configDir, 'service-account-dev.json', sa('myapp-dev'));
    expect(loadFirebaseSetup([], { ...opts(), adminProjectId: 'myapp-dev' }).adminProjectId).toBe('myapp-dev');
    expect(() => loadFirebaseSetup([], { ...opts(), adminProjectId: 'nope' })).toThrow(/admin project "nope" is not an accepted project/);
  });
});
