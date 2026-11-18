import compress from '@fastify/compress';
import cors from '@fastify/cors';
import { STATUS_CODES } from 'node:http';
import Fastify from 'fastify';
import { debugUi } from './debugUi.js';
import { errorBody, principal, requireAdmin, requireFirebaseUser } from './auth.js';
import { MemoryStore } from './cache/memory.js';
import { RedisStore } from './cache/redis.js';
import { TieredStore } from './cache/tiered.js';
import { KeyPool } from './keyPool.js';
import { BibleProxy } from './proxy.js';
import { MemoryRateLimiter, RedisRateLimiter } from './rateLimit.js';
import { buildUpstreamPath, ID_PATTERN, normalizeQuery, RequestValidationError, ROUTES } from './routes.js';
import { ApiBibleClient } from './upstream.js';

export async function buildApp(deps) {
  const { config } = deps;
  const now = deps.now ?? Date.now;

  const app = Fastify({
    trustProxy: config.trustProxy,
    routerOptions: { maxParamLength: 256 },
    logger:
      deps.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: ['req.headers.authorization', 'req.headers["x-firebase-appcheck"]'],
          },
  });

  // --- Infrastructure -------------------------------------------------------
  const redis = deps.redis ?? (config.cache.redisUrl ? RedisStore.connect(config.cache.redisUrl, config.cache.redisKeyPrefix, now) : undefined);
  if (redis && !(await redis.waitReady(5_000))) {
    app.log.warn('Redis not reachable at startup; continuing with memory cache until it connects');
  }
  const memory = new MemoryStore({
    maxBytes: config.cache.memoryMaxBytes,
    // Without a shared tier, memory is the only cache; let entries live their full life.
    maxTtlMs: redis ? config.cache.memoryMaxTtlSeconds * 1000 : undefined,
    now,
  });
  const cache = new TieredStore(memory, redis, app.log);
  const limiter = redis
    ? new RedisRateLimiter(redis.client, config.cache.redisKeyPrefix, app.log, now)
    : new MemoryRateLimiter(now);
  const keys = new KeyPool(config.upstream.keys, now);
  const upstream = new ApiBibleClient({
    baseUrl: config.upstream.baseUrl,
    keys,
    timeoutMs: config.upstream.timeoutMs,
    log: app.log,
    fetch: deps.fetch,
  });
  const proxy = new BibleProxy({
    cache,
    upstream,
    limiter,
    ttlSeconds: config.cache.ttlSeconds,
    staleIfErrorSeconds: config.cache.staleIfErrorSeconds,
    upstreamPerMinute: config.rateLimit.upstreamPerMinute,
    log: app.log,
    now,
  });

  app.addHook('onClose', async () => cache.close());

  if (config.corsOrigins.length) {
    await app.register(cors, {
      origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Authorization', 'X-Firebase-AppCheck', 'If-None-Match', 'Content-Type'],
      exposedHeaders: ['ETag', 'X-Cache', 'Age', 'Retry-After'],
      maxAge: 86400,
    });
  }
  await app.register(compress, { global: true, threshold: 1024 });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof RequestValidationError) {
      return reply.code(400).send(errorBody(400, 'Bad Request', err.message));
    }
    const status = err.statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send(errorBody(status, STATUS_CODES[status] ?? 'Error', err.message));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(errorBody(500, 'Internal Server Error', 'Unexpected error.'));
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send(errorBody(404, 'Not Found', `No route for ${req.method} ${req.url.split('?')[0]}`)),
  );

  // Static sign-in page + console. Everything it loads after sign-in sits behind requireAdmin.
  await app.register(debugUi, { firebaseClientConfigs: deps.firebaseClientConfigs ?? [] });

  // --- Health (unauthenticated) ----------------------------------------------
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    if (redis) {
      try {
        await redis.client.ping();
      } catch {
        return reply.code(503).send({ status: 'degraded', redis: 'unreachable' });
      }
    }
    return { status: 'ok' };
  });

  const authenticate = requireFirebaseUser({
    verifier: deps.verifier,
    requireAppCheck: config.firebase.requireAppCheck,
    allowAnonymous: config.firebase.allowAnonymous,
  });
  const authorizeAdmin = requireAdmin({ verifier: deps.verifier, adminProjectId: deps.adminProjectId, now });

  /**
   * The API.Bible routes, mounted under /v1 (app clients, rate limited) and /admin/v1
   * (admins, `rateLimit: false`: no per-user request limit or upstream budget).
   */
  const bibleRoutes = async (scope, { rateLimit = true }) => {
    if (rateLimit) {
      scope.addHook('preHandler', async (req, reply) => {
        const r = await limiter.hit(`req:${principal(req.user)}`, config.rateLimit.requestsPerMinute);
        if (!r.allowed) {
          return reply
            .code(429)
            .header('retry-after', r.retryAfterSec)
            .send(errorBody(429, 'Too Many Requests', 'Rate limit exceeded.'));
        }
      });
    }
    for (const route of ROUTES) {
      scope.get(route.path, async (req, reply) => {
        const path = buildUpstreamPath(route, req.params);
        const query = normalizeQuery(route, req.query);
        const result = await proxy.get({
          path,
          query,
          cacheClass: route.cacheClass,
          uid: principal(req.user),
          rateLimit,
        });
        return sendResult(reply, result, req.headers['if-none-match']);
      });
    }
  };

  // --- Bible API for app clients (Firebase user, App Check / anonymous rules) --
  await app.register(
    async (v1) => {
      v1.addHook('preHandler', authenticate);
      await v1.register(bibleRoutes, { rateLimit: true });
    },
    { prefix: '/v1' },
  );

  function sendResult(reply, result, ifNoneMatch) {
    if (result.kind === 'error') {
      if (result.retryAfterSec) reply.header('retry-after', result.retryAfterSec);
      return reply.code(result.status).send(errorBody(result.status, result.code, result.message));
    }
    const { entry, cache: cacheStatus } = result;
    const t = now();
    const maxAge =
      cacheStatus === 'STALE'
        ? 0
        : Math.max(0, Math.min(config.cache.clientMaxAgeSeconds, Math.floor((entry.freshUntil - t) / 1000)));
    reply
      .header('x-cache', cacheStatus)
      .header('age', Math.max(0, Math.floor((t - entry.fetchedAt) / 1000)))
      .header('cache-control', maxAge > 0 ? `private, max-age=${maxAge}` : 'private, no-cache')
      .header('etag', entry.etag);
    if (entry.status === 200 && ifNoneMatch && etagMatches(ifNoneMatch, entry.etag)) {
      return reply.code(304).send();
    }
    return reply.code(entry.status).type('application/json; charset=utf-8').send(entry.body);
  }

  // --- Admin: Firestore users/{uid}.is_admin (same model as wpa-be-admin) ------
  await app.register(
    async (admin) => {
      admin.addHook('preHandler', authorizeAdmin);

      /** Used by the debug console to confirm the signed-in user is an admin. */
      admin.get('/whoami', async (req) => {
        const u = req.user;
        return { uid: u.uid, email: u.claims.email ?? null, projectId: u.projectId ?? null };
      });

      /** Route allowlist, for the debug console's request builder. */
      admin.get('/routes', async () => ROUTES);

      /**
       * Same Bible routes as /v1, for admins testing API.Bible through the proxy without the
       * client-side checks (App Check, anonymous-user rule) and without per-user rate limits.
       * Still cached; misses spend real API.Bible quota.
       */
      await admin.register(bibleRoutes, { prefix: '/v1', rateLimit: false });

      admin.get('/stats', async () => ({
        cache: { backend: cache.name, memoryEntries: memory.size, ...proxy.stats },
        upstream: { requests: upstream.requestCount, keys: keys.status() },
      }));

      /**
       * Purge cached content, e.g. to honour an API.Bible removal request (Terms §13.2: 24h).
       * Body: { "all": true } | { "bibleId": "..." } | { "audioBibleId": "..." }
       */
      admin.post(
        '/cache/purge',
        {
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                all: { type: 'boolean' },
                bibleId: { type: 'string', pattern: ID_PATTERN.source },
                audioBibleId: { type: 'string', pattern: ID_PATTERN.source },
              },
              minProperties: 1,
            },
          },
        },
        async (req) => {
          const { all, bibleId, audioBibleId } = req.body;
          if (all) {
            const deleted = await cache.clear();
            req.log.warn({ by: principal(req.user) }, 'cache fully purged');
            return { purged: 'all', deleted };
          }
          const prefixes = [];
          for (const [base, id] of [['/bibles', bibleId], ['/audio-bibles', audioBibleId]]) {
            if (!id) continue;
            const enc = encodeURIComponent(id);
            // The resource itself, everything beneath it, and list pages that may mention it.
            prefixes.push(`${base}/${enc}?`, `${base}/${enc}/`, `${base}?`);
          }
          const deleted = await cache.deleteByPrefix(prefixes);
          req.log.warn({ by: principal(req.user), bibleId, audioBibleId, deleted }, 'cache purged');
          return { purged: prefixes, deleted };
        },
      );
    },
    { prefix: '/admin' },
  );

  return app;
}

function etagMatches(header, etag) {
  if (header.trim() === '*') return true;
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}
