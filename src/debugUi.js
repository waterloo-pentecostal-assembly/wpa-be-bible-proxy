import { readFile } from 'node:fs/promises';

/** public/ sits next to src/. */
const ASSET_DIR = new URL('../public/debug/', import.meta.url);

const ASSETS = {
  '': { file: 'index.html', type: 'text/html; charset=utf-8' },
  'app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  'app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

/**
 * Only static assets are public: the page shows a sign-in form and nothing else until
 * /admin/whoami confirms the user is an admin. All data it loads (routes, stats, purge,
 * Bible requests) comes from authenticated endpoints. Scripts may only talk to this origin and to the
 * Firebase Auth REST endpoints used by the email/password sign-in form.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Engineer-facing debug console at /debug, gated by admin sign-in. */
export async function debugUi(app, opts) {
  const files = new Map();
  for (const [name, { file, type }] of Object.entries(ASSETS)) {
    files.set(name, { body: await readFile(new URL(file, ASSET_DIR)), type });
  }

  const headers = {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    // Origin only (never the path): Firebase web API keys restricted to "websites" check it.
    'referrer-policy': 'strict-origin',
    'cache-control': 'no-store',
  };

  app.get('/debug', async (_req, reply) => reply.redirect('/debug/', 301));

  /**
   * Public, like wpa-be-admin's /api/firebase-config: the page needs it before sign-in to know
   * which Firebase project(s) to sign in to. Web API keys are not secrets.
   */
  const clientConfig = JSON.stringify({ projects: opts.firebaseClientConfigs });
  app.get('/debug/firebase-config', async (_req, reply) =>
    reply.headers(headers).type('application/json; charset=utf-8').send(clientConfig),
  );
  app.get('/debug/:asset', async (req, reply) => {
    const asset = files.get(req.params.asset);
    if (!asset) return reply.callNotFound();
    return reply.headers(headers).type(asset.type).send(asset.body);
  });
  app.get('/debug/', async (_req, reply) => {
    const asset = files.get('');
    return reply.headers(headers).type(asset.type).send(asset.body);
  });
}
