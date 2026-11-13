import { z } from 'zod';

/**
 * API.Bible Terms §11: cached content must never be more than 30 days out of date.
 * This is a hard ceiling that no configuration can exceed. We keep a one-day safety
 * margin so clock skew / in-flight responses can never push us over the limit.
 */
export const MAX_CONTENT_AGE_SECONDS = 29 * 24 * 60 * 60;

const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : ['true', '1', 'yes'].includes(v)));

const int = (def, min = 0) => z.coerce.number().int().min(min).default(def);

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const ttl = (def) =>
  int(def, 0).transform((v) => Math.min(v, MAX_CONTENT_AGE_SECONDS));

const EnvSchema = z.object({
  PORT: int(8080, 1),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: bool(true),

  // --- API.Bible ---
  API_BIBLE_BASE_URL: z.url().default('https://rest.api.bible/v1'),
  /** Comma-separated. First key is primary; others are used for failover / rotation. */
  API_BIBLE_KEYS: csv.refine((keys) => keys.length > 0, 'API_BIBLE_KEYS must contain at least one key'),
  UPSTREAM_TIMEOUT_MS: int(10_000, 100),

  // --- Firebase ---
  /**
   * Extra Firebase projects whose users may call the proxy, comma-separated. Projects with a
   * service account in src/config/ (see config/firebase.js) are accepted automatically, so this
   * is only needed for projects without one. FIREBASE_PROJECT_ID (single) is merged in too.
   */
  FIREBASE_PROJECT_IDS: csv,
  FIREBASE_PROJECT_ID: z.string().optional(),
  /**
   * The only project whose admins may use /admin and the /debug console. Defaults to the prod
   * service account's project (src/config/service-account.json). Users of every accepted project
   * may still call /v1.
   */
  FIREBASE_ADMIN_PROJECT_ID: z.string().trim().min(1).optional(),
  /** Extra network round-trip per request; also rejects disabled users. */
  FIREBASE_CHECK_REVOKED: bool(false),
  /** Require a valid X-Firebase-AppCheck header (proves the call comes from your genuine app). */
  FIREBASE_REQUIRE_APP_CHECK: bool(false),
  /** Allow users signed in with Firebase Anonymous Auth. */
  ALLOW_ANONYMOUS_USERS: bool(false),

  // --- Cache ---
  REDIS_URL: z.string().optional(),
  REDIS_KEY_PREFIX: z.string().default('bible-proxy:'),
  MEMORY_CACHE_MAX_MB: int(128, 1),
  /** When Redis is the shared tier, bound per-instance memory entries so purges propagate quickly. */
  MEMORY_CACHE_MAX_TTL_SECONDS: int(3600, 1),
  /** Scripture text: bibles' content rarely changes. */
  CACHE_TTL_CONTENT_SECONDS: ttl(7 * 24 * 3600),
  /** Bible lists, book lists, etc. */
  CACHE_TTL_METADATA_SECONDS: ttl(24 * 3600),
  CACHE_TTL_SEARCH_SECONDS: ttl(24 * 3600),
  /** Upstream 400/403/404 responses (prevents repeated misses from burning quota). */
  CACHE_TTL_NEGATIVE_SECONDS: ttl(10 * 60),
  /** Max age at which a stale entry may still be served when API.Bible is down / quota exhausted. */
  CACHE_STALE_IF_ERROR_SECONDS: ttl(MAX_CONTENT_AGE_SECONDS),
  /** max-age advertised to clients so apps can also cache locally. */
  CLIENT_MAX_AGE_SECONDS: int(3600, 0),

  // --- Abuse protection (per Firebase uid) ---
  RATE_LIMIT_REQUESTS_PER_MINUTE: int(300, 1),
  /** Requests that miss the cache and cost an API.Bible call. Protects your monthly quota. */
  RATE_LIMIT_UPSTREAM_PER_MINUTE: int(30, 1),

  // --- HTTP ---
  /** Comma-separated origins allowed for browser clients. Empty = CORS disabled. "*" = any. */
  CORS_ORIGINS: csv,
});

export function loadConfig(env = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const c = parsed.data;
  const projectIds = [...new Set([...(c.FIREBASE_PROJECT_ID ? [c.FIREBASE_PROJECT_ID.trim()] : []), ...c.FIREBASE_PROJECT_IDS])];

  return {
    port: c.PORT,
    host: c.HOST,
    logLevel: c.LOG_LEVEL,
    trustProxy: c.TRUST_PROXY,
    upstream: {
      baseUrl: c.API_BIBLE_BASE_URL.replace(/\/+$/, ''),
      keys: c.API_BIBLE_KEYS,
      timeoutMs: c.UPSTREAM_TIMEOUT_MS,
    },
    firebase: {
      projectIds,
      adminProjectId: c.FIREBASE_ADMIN_PROJECT_ID,
      checkRevoked: c.FIREBASE_CHECK_REVOKED,
      requireAppCheck: c.FIREBASE_REQUIRE_APP_CHECK,
      allowAnonymous: c.ALLOW_ANONYMOUS_USERS,
    },
    cache: {
      redisUrl: c.REDIS_URL,
      redisKeyPrefix: c.REDIS_KEY_PREFIX,
      memoryMaxBytes: c.MEMORY_CACHE_MAX_MB * 1024 * 1024,
      memoryMaxTtlSeconds: c.MEMORY_CACHE_MAX_TTL_SECONDS,
      ttlSeconds: {
        content: c.CACHE_TTL_CONTENT_SECONDS,
        metadata: c.CACHE_TTL_METADATA_SECONDS,
        search: c.CACHE_TTL_SEARCH_SECONDS,
        negative: c.CACHE_TTL_NEGATIVE_SECONDS,
      },
      staleIfErrorSeconds: c.CACHE_STALE_IF_ERROR_SECONDS,
      clientMaxAgeSeconds: c.CLIENT_MAX_AGE_SECONDS,
    },
    rateLimit: {
      requestsPerMinute: c.RATE_LIMIT_REQUESTS_PER_MINUTE,
      upstreamPerMinute: c.RATE_LIMIT_UPSTREAM_PER_MINUTE,
    },
    corsOrigins: c.CORS_ORIGINS,
  };
}
