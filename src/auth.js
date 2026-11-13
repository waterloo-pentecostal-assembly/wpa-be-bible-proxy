import { createHash } from 'node:crypto';
import { getAppCheck } from 'firebase-admin/app-check';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

/** Stable per-user identity for rate limits and logs. uids are only unique within a project. */
export function principal(user) {
  return user.projectId ? `${user.projectId}/${user.uid}` : user.uid;
}

export class AuthError extends Error {
  code;

  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Verifies tokens from one or more Firebase projects (e.g. dev and prod).
 *
 * The token's `aud` claim is read *unverified* only to choose which project's verifier to use;
 * that verifier then checks signature, expiry, issuer and that `aud` matches its own project.
 * Tokens from projects that aren't configured are rejected before any verification work.
 */
export class FirebaseVerifier {
  byProject = new Map();
  /** Single app with an inferred project id (FIREBASE_PROJECT_ID(S) unset). */
  fallback;

  checkRevoked;

  constructor(apps, checkRevoked) {
    this.checkRevoked = checkRevoked;
    if (apps.length === 0) throw new Error('FirebaseVerifier requires at least one Firebase app');
    for (const app of apps) {
      const id = app.options.projectId;
      if (id) this.byProject.set(id, app);
      else if (apps.length === 1) this.fallback = app;
      else throw new Error('Every Firebase app needs an explicit projectId when using multiple projects');
    }
  }

  appFor(projectId) {
    return (projectId && this.byProject.get(projectId)) || this.fallback;
  }

  /** With checkRevoked it also rejects revoked sessions and disabled users. */
  async verifyIdToken(idToken, opts = {}) {
    const aud = projectIdFromToken(idToken);
    const app = this.appFor(aud);
    if (!app) throw new AuthError('auth/project-not-allowed', `Token audience "${aud}" is not an allowed project`);
    const decoded = await getAuth(app).verifyIdToken(idToken, opts.checkRevoked ?? this.checkRevoked);
    return {
      uid: decoded.uid,
      projectId: decoded.aud,
      signInProvider: decoded.firebase?.sign_in_provider,
      claims: decoded,
    };
  }

  /** App Check tokens are verified against the same project the user's ID token came from. */
  async verifyAppCheckToken(token, user) {
    const app = this.appFor(user.projectId);
    if (!app) throw new AuthError('appcheck/project-not-allowed', 'No Firebase app for this project');
    await getAppCheck(app).verifyToken(token);
  }

  /**
   * Looks up `users/{uid}` in the token's project. If there is no profile under the uid, falls
   * back to a profile with the same email, but only for verified emails, so nobody can claim an
   * admin's profile by registering an unverified account with that address.
   */
  async isAdmin(user) {
    const app = this.appFor(user.projectId);
    if (!app) return false;
    const users = getFirestore(app).collection('users');
    const profile = await users.doc(user.uid).get();
    if (profile.exists) return profile.get('is_admin') === true;
    const { email, email_verified: verified } = user.claims;
    if (typeof email !== 'string' || verified !== true) return false;
    const byEmail = await users.where('email', '==', email).get();
    return byEmail.docs.some((doc) => doc.get('is_admin') === true);
  }
}

/** Read the `aud` claim of a JWT without verifying it. Use only for routing. */
export function projectIdFromToken(token) {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const aud = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).aud;
    return typeof aud === 'string' ? aud : undefined;
  } catch {
    return undefined;
  }
}

function bearerToken(req) {
  return req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
}

/** Fastify preHandler for app clients: requires `Authorization: Bearer <Firebase ID token>`. */
export function requireFirebaseUser(opts) {
  return async function authenticate(req, reply) {
    const token = bearerToken(req);
    if (!token) return unauthorized(reply, 'Missing bearer token.');

    let user;
    try {
      user = await opts.verifier.verifyIdToken(token);
    } catch (err) {
      req.log.info({ reason: err.code ?? err.message }, 'ID token rejected');
      return unauthorized(reply, 'Invalid or expired ID token.');
    }

    if (!opts.allowAnonymous && user.signInProvider === 'anonymous') {
      return reply.code(403).send(errorBody(403, 'Forbidden', 'Anonymous users are not allowed.'));
    }

    if (opts.requireAppCheck) {
      const appCheck = req.headers['x-firebase-appcheck'];
      if (typeof appCheck !== 'string' || !appCheck) return unauthorized(reply, 'Missing App Check token.');
      try {
        await opts.verifier.verifyAppCheckToken(appCheck, user);
      } catch {
        return unauthorized(reply, 'Invalid App Check token.');
      }
    }

    req.user = user;
  };
}

/**
 * Fastify preHandler for admin routes and the debug console. Same model as wpa-be-admin:
 *   1. Bearer ID token, verified with revocation check (disabled / signed-out admins rejected).
 *   2. Firestore `users/{uid}.is_admin === true` in the token's project.
 *   3. With `adminProjectId`, only that project's users can be admins: tokens from the other
 *      accepted projects still work on /v1 but get 403 here.
 *   4. Result cached for up to a minute (never past token expiry), so admin removal can take
 *      up to `cacheTtlMs` to apply.
 * 401 bad token · 403 not an admin · 503 admin lookup failed.
 */
export function requireAdmin(opts) {
  const ttl = opts.cacheTtlMs ?? 60_000;
  const max = opts.cacheMaxEntries ?? 500;
  const now = opts.now ?? Date.now;
  // Keyed by a hash so raw tokens are not kept in memory longer than needed.
  const cache = new Map();

  return async function authorizeAdmin(req, reply) {
    const token = bearerToken(req);
    if (!token) return unauthorized(reply, 'Missing bearer token.');

    const key = createHash('sha256').update(token).digest('base64url');
    const cached = cache.get(key);
    if (cached && cached.until > now()) {
      req.user = cached.user;
      return;
    }
    cache.delete(key);

    let user;
    try {
      user = await opts.verifier.verifyIdToken(token, { checkRevoked: true });
    } catch (err) {
      req.log.info({ reason: err.code ?? err.message }, 'admin ID token rejected');
      return unauthorized(reply, 'Invalid, expired or revoked ID token.');
    }

    if (opts.adminProjectId && user.projectId !== opts.adminProjectId) {
      req.log.warn({ uid: user.uid, projectId: user.projectId }, 'admin access attempted from a non-admin project');
      return reply.code(403).send(errorBody(403, 'Forbidden', `Admin access requires a ${opts.adminProjectId} account.`));
    }

    let admin;
    try {
      admin = await opts.verifier.isAdmin(user);
    } catch (err) {
      req.log.error({ err, uid: user.uid, projectId: user.projectId }, 'admin lookup failed');
      return reply.code(503).send(errorBody(503, 'Service Unavailable', 'Could not verify admin status.'));
    }
    if (!admin) {
      req.log.warn({ uid: user.uid, projectId: user.projectId }, 'non-admin attempted admin access');
      return reply.code(403).send(errorBody(403, 'Forbidden', 'Admin access required.'));
    }

    const exp = typeof user.claims.exp === 'number' ? user.claims.exp * 1000 : Infinity;
    cache.set(key, { user, until: Math.min(now() + ttl, exp) });
    if (cache.size > max) cache.delete(cache.keys().next().value);
    req.user = user;
  };
}

function unauthorized(reply, message) {
  return reply
    .code(401)
    .header('www-authenticate', 'Bearer realm="wpa-be-bible-proxy"')
    .send(errorBody(401, 'Unauthorized', message));
}

/** Same error shape API.Bible uses, so clients handle both identically. */
export function errorBody(statusCode, error, message) {
  return { statusCode, error, message };
}
