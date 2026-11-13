/**
 * Firebase credentials and client config, laid out like wpa-be-admin's src/config/:
 *
 *   src/config/service-account.json        prod service account (Firebase console → Project
 *   src/config/service-account-dev.json    dev  service account     settings → Service accounts)
 *   src/config/firebase-client-config.json web config the debug console signs in with (Firebase
 *                                          console → Project settings → Your apps → Web app)
 *
 * Each file is looked up in the same order as wpa-be-admin:
 *   1. /etc/secrets/<file>          (secret files mounted by Render / Cloud Run / k8s)
 *   2. env var with the JSON inline (FIREBASE_SERVICE_ACCOUNT, FIREBASE_SERVICE_ACCOUNT_DEV,
 *                                    FIREBASE_CLIENT_CONFIG)
 *   3. src/config/<file>            (local development; gitignored)
 *
 * The JSON files are gitignored and excluded from the Docker build context.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** <root>/src/config (this file lives in src/config). */
export const CONFIG_DIR = fileURLToPath(new URL('../../src/config/', import.meta.url));
export const SECRETS_DIR = '/etc/secrets';

const SERVICE_ACCOUNTS = {
  prod: { file: 'service-account.json', envVar: 'FIREBASE_SERVICE_ACCOUNT' },
  dev: { file: 'service-account-dev.json', envVar: 'FIREBASE_SERVICE_ACCOUNT_DEV' },
};
const CLIENT_CONFIG = { file: 'firebase-client-config.json', envVar: 'FIREBASE_CLIENT_CONFIG' };

function readSource(name, opts) {
  const secret = join(opts.secretsDir, name.file);
  if (existsSync(secret)) return { label: secret, raw: readFileSync(secret, 'utf8') };
  const inline = opts.env[name.envVar];
  if (inline?.trim()) return { label: `$${name.envVar}`, raw: inline };
  const local = join(opts.configDir, name.file);
  if (existsSync(local)) return { label: `src/config/${name.file}`, raw: readFileSync(local, 'utf8') };
  return undefined;
}

class FirebaseConfigError extends Error {
  constructor(problems) {
    super(`Invalid Firebase configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}

/** Parse JSON from a source; errors name the source but never include its contents. */
function parseJson(src) {
  try {
    return JSON.parse(src.raw);
  } catch {
    throw new FirebaseConfigError([`${src.label}: not valid JSON`]);
  }
}

function describeIssues(err) {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ');
}

// --- Service accounts ----------------------------------------------------------

const ServiceAccountSchema = z.looseObject({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});

export function loadServiceAccounts(options = {}) {
  const opts = withDefaults(options);
  const accounts = [];
  for (const env of ['prod', 'dev']) {
    const src = readSource(SERVICE_ACCOUNTS[env], opts);
    if (!src) continue;
    const result = ServiceAccountSchema.safeParse(parseJson(src));
    if (!result.success) {
      throw new FirebaseConfigError([`${src.label}: not a service account key (${describeIssues(result.error)})`]);
    }
    accounts.push({ env, projectId: result.data.project_id, json: result.data, source: src.label });
  }
  const [prod, dev] = [accounts.find((a) => a.env === 'prod'), accounts.find((a) => a.env === 'dev')];
  if (prod && dev && prod.projectId === dev.projectId) {
    throw new FirebaseConfigError([`${prod.source} and ${dev.source} are both for project "${prod.projectId}"`]);
  }
  return accounts;
}

// --- Client (web) config -------------------------------------------------------

/** Firebase *web* config. Public by design: it ships in every web/mobile app build. */
const ClientConfigSchema = z.object({
  apiKey: z.string().min(1),
  projectId: z.string().min(1),
  authDomain: z.string().optional(),
});

/** firebase-client-config.json: one web config object, or an array of them (e.g. dev + prod). */
export function loadClientConfigs(options = {}) {
  const opts = withDefaults(options);
  const src = readSource(CLIENT_CONFIG, opts);
  if (!src) return { configs: [] };
  const json = parseJson(src);
  const result = z.array(ClientConfigSchema).min(1).safeParse(Array.isArray(json) ? json : [json]);
  if (!result.success) {
    throw new FirebaseConfigError([`${src.label}: each entry needs string "apiKey" and "projectId" (${describeIssues(result.error)})`]);
  }
  const configs = result.data.map(({ apiKey, projectId, authDomain }) => ({ apiKey, projectId, authDomain }));
  const ids = configs.map((c) => c.projectId);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length) throw new FirebaseConfigError(dupes.map((id) => `${src.label}: duplicate entry for project "${id}"`));
  return { configs, source: src.label };
}

// --- Combined --------------------------------------------------------------------

/**
 * @param extraProjectIds  FIREBASE_PROJECT_ID(S): accepted projects without a service account
 * @param options.adminProjectId  FIREBASE_ADMIN_PROJECT_ID; defaults to the prod service account's
 *   project. Only its admins may use /admin, and the console signs in to it alone.
 */
export function loadFirebaseSetup(extraProjectIds, options = {}) {
  const serviceAccounts = loadServiceAccounts(options);
  const projectIds = [...new Set([...serviceAccounts.map((a) => a.projectId), ...extraProjectIds])];
  const { configs: clientConfigs, source: clientSource } = loadClientConfigs(options);

  if (projectIds.length) {
    const unknown = clientConfigs.filter((c) => !projectIds.includes(c.projectId));
    if (unknown.length) {
      throw new FirebaseConfigError(
        unknown.map(
          (c) => `${clientSource}: project "${c.projectId}" has no service account and is not in FIREBASE_PROJECT_IDS`,
        ),
      );
    }
  }

  const adminProjectId = options.adminProjectId ?? serviceAccounts.find((a) => a.env === 'prod')?.projectId;
  if (adminProjectId && projectIds.length && !projectIds.includes(adminProjectId)) {
    throw new FirebaseConfigError([`admin project "${adminProjectId}" is not an accepted project (no service account, not in FIREBASE_PROJECT_IDS)`]);
  }
  // The console signs in to the admin project only; other projects' web configs are not published.
  const consoleConfigs = adminProjectId ? clientConfigs.filter((c) => c.projectId === adminProjectId) : clientConfigs;

  const sources = {};
  for (const a of serviceAccounts) sources[`serviceAccount.${a.env}`] = `${a.source} (${a.projectId})`;
  if (consoleConfigs.length) sources.clientConfig = `${clientSource} (${consoleConfigs.map((c) => c.projectId).join(', ')})`;
  return { projectIds, adminProjectId, serviceAccounts, clientConfigs: consoleConfigs, sources };
}

function withDefaults(o) {
  return { env: o.env ?? process.env, configDir: o.configDir ?? CONFIG_DIR, secretsDir: o.secretsDir ?? SECRETS_DIR };
}
