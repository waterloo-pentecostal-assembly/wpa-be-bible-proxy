import { cert, initializeApp } from 'firebase-admin/app';
import { buildApp } from './app.js';
import { FirebaseVerifier } from './auth.js';
import { loadConfig } from './config/config.js';
import { loadFirebaseSetup } from './config/firebase.js';

const config = loadConfig();

// Service accounts and the console's web config come from src/config/ (or /etc/secrets, or
// env vars), like wpa-be-admin. See config/firebase.js.
const firebaseSetup = loadFirebaseSetup(config.firebase.projectIds, { adminProjectId: config.firebase.adminProjectId });
const { projectIds } = firebaseSetup;

// One firebase-admin app per accepted project. With a service account, admin checks
// (revocation + Firestore users/{uid}.is_admin) use its credentials. Without one, client
// token verification still works from the project id alone, and admin checks fall back to
// Application Default Credentials. Honors FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST.
const firebaseApps = projectIds.length
  ? projectIds.map((projectId) => {
      const account = firebaseSetup.serviceAccounts.find((a) => a.projectId === projectId);
      return initializeApp(account ? { projectId, credential: cert(account.json) } : { projectId }, projectId);
    })
  : [initializeApp()];

const app = await buildApp({
  config,
  verifier: new FirebaseVerifier(firebaseApps, config.firebase.checkRevoked),
  adminProjectId: firebaseSetup.adminProjectId,
  firebaseClientConfigs: firebaseSetup.clientConfigs,
});

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  });
}

if (!firebaseSetup.clientConfigs.length) {
  app.log.warn(
    `No Firebase web config for ${firebaseSetup.adminProjectId ?? 'the admin project'}, so the /debug console cannot sign in. ` +
      'Add its web config to src/config/firebase-client-config.json (or /etc/secrets/, or FIREBASE_CLIENT_CONFIG).',
  );
}

await app.listen({ port: config.port, host: config.host });
app.log.info(
  { firebaseProjects: projectIds.length ? projectIds : '(inferred)', adminProject: firebaseSetup.adminProjectId ?? '(any)', firebaseConfig: firebaseSetup.sources, keys: config.upstream.keys.length, cache: config.cache.redisUrl ? 'memory+redis' : 'memory' },
  'WPA BE Bible Proxy ready',
);
