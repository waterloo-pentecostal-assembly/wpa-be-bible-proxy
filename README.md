# WPA BE Bible Proxy

An authenticated caching proxy between the WPA BE apps (web and mobile) and [API.Bible](https://api.bible). Plain JavaScript (Node.js, ES modules), no build step.

```
 ┌──────────┐  Firebase ID token   ┌─────────────────────────────┐   api-key   ┌───────────┐
 │ web/iOS/ │ ───────────────────▶ │ WPA BE Bible Proxy          │ ──────────▶ │ API.Bible │
 │ Android  │ ◀─────────────────── │  auth → rate limit → cache  │ ◀────────── │           │
 └──────────┘   same JSON as       │  (memory, optional Redis)   │  only on    └───────────┘
                API.Bible          └─────────────────────────────┘  cache miss
```

- **Firebase auth.** Every `/v1/*` call needs `Authorization: Bearer <Firebase ID token>` from an accepted Firebase project: `wpa-be-app` (prod) or `wpa-be-app-dev` (dev). Tokens are verified with `firebase-admin` (signature, expiry, audience, issuer). App Check, rejecting anonymous users and revocation checks are optional.
- **API keys stay on the server.** API.Bible keys live only in the proxy's environment. They are never logged or returned, and `/admin/stats` shows them masked. A key that gets a 429 or 401 is paused, and the next key is tried.
- **Caching that saves quota.** Identical requests share one cache entry and one in-flight API.Bible call, so 1,000 users opening John 3:16 cost **one** call. Query strings are normalized, and unknown parameters are rejected so clients can't bypass the cache. Stale content is served if API.Bible is down or out of quota. ETag/304 saves mobile bandwidth.
- **Abuse protection.** Per-user limits per minute, with a stricter limit on cache misses (the only requests that use your API.Bible quota).
- **Admin console.** `/debug/` is a browser console for wpa-be-app admins. It signs in the same way as wpa-be-admin.
- **Follows API.Bible's terms.** Content is never served more than 29 days after it was fetched (§11 requires ≤ 30), and an admin purge endpoint handles removal requests (§13.2: 24 h).

## Contents

- [How it works](#how-it-works): request flow, project structure, caching, Redis, authentication
- [API](#api): endpoints, choosing a Bible version, headers, errors, admin endpoints, debug console
- [Client usage](#client-usage)
- [Configuration](#configuration): environment variables, Firebase files
- [Running locally](#running-locally)
- [Hosting on Render](#hosting-on-render)
- [Other hosts](#other-hosts)
- [Rotating API keys](#rotating-api-keys)

---

## How it works

### Request flow

What happens to `GET /v1/bibles/{bibleId}/verses/JHN.3.16`:

1. **Authenticate** (`src/auth.js`). The bearer token's `aud` claim picks the Firebase project, and that project verifies the token. Missing or invalid tokens get `401`. Anonymous users get `403` unless allowed. App Check is checked if required.
2. **Per-user request limit** (`src/rateLimit.js`). Counted per `project/uid`, `RATE_LIMIT_REQUESTS_PER_MINUTE` (default 300). Over the limit: `429` with `Retry-After`.
3. **Validate and normalize** (`src/routes.js`). The path must match the route allowlist, and path IDs must look like API.Bible IDs (`400` otherwise). Query parameters must be ones API.Bible documents for that route, each given once. They're trimmed and sorted, so `?b=1&a=2` and `?a=2&b=1` share a cache entry.
4. **Cache lookup** (`src/proxy.js`, `src/cache/`). Memory first, then Redis if configured. A fresh entry is returned at once (`X-Cache: HIT`).
5. **Merge identical requests** (`src/singleflight.js`). If the same key is already being fetched, the request waits for that result instead of making another call.
6. **Per-user upstream budget.** A request that would cost an API.Bible call counts against `RATE_LIMIT_UPSTREAM_PER_MINUTE` (default 30). Over budget: a stale copy if there is one, otherwise `429`.
7. **Call API.Bible** (`src/upstream.js`, `src/keyPool.js`). Keys are tried in priority order:
   - **401:** the key is paused for 10 minutes and the next key is tried.
   - **429:** the key is paused for `Retry-After` (or 60 s) and the next key is tried.
   - **403:** the Bible isn't licensed for this key, so the next key is tried.
   - **200, 400 and 404** are final.
8. **Store and respond.** Successful responses and short-lived 400/403/404 results are cached. The body is returned byte-for-byte (`X-Cache: MISS`). If API.Bible is unreachable or every key is paused, a stale copy is served (`X-Cache: STALE`) if one exists. Otherwise the client gets `502` or `503`.

### Project structure

```
src/
  server.js          entrypoint: loads config + Firebase files, starts firebase-admin (one app per
                     project), builds the app, listens on PORT, shuts down gracefully on SIGTERM
  app.js             Fastify wiring: CORS, compression, error shape, health checks, /v1 routes,
                     /admin routes, debug console. Creates the cache, rate limiter, key pool and client
  config/
    config.js        environment variables → validated config (zod). Clamps every TTL to 29 days
    firebase.js      loads service-account.json, service-account-dev.json, firebase-client-config.json
                     (/etc/secrets → env var → src/config) and picks the admin project
    *.json           your Firebase files (gitignored, never in the Docker image)
  auth.js            Firebase ID-token / App Check verification (multi-project), client and admin guards,
                     Firestore users/{uid}.is_admin lookup
  routes.js          API.Bible endpoint allowlist, path-ID validation, query normalization
  proxy.js           cache → merge → upstream budget → API.Bible → store → stale-if-error
  upstream.js        API.Bible HTTP client with per-key failover
  keyPool.js         API key priority, cooldowns, masking
  singleflight.js    merges concurrent requests for the same key
  rateLimit.js       fixed-window per-user limiter (memory or Redis)
  debugUi.js         serves the /debug console (static files + public Firebase web config)
  cache/
    memory.js        in-process LRU, size-bounded
    redis.js         Redis store (optional)
    tiered.js        memory in front of Redis; Redis errors become cache misses
public/debug/        debug console: index.html, app.js, app.css (no build step)
test/                vitest suites with a fake Firebase verifier, fake API.Bible and fake clock
render.yaml          Render Blueprint (see Hosting on Render)
Dockerfile           container image for Docker-based hosts
docker-compose.yml   local proxy + Redis
.env.example         every environment variable, annotated
.node-version        Node version for Render (24)
```

### Caching

| Cache class | Used for | Fresh for (default) |
|---|---|---|
| content | chapters, passages, sections, verses | 7 days (`CACHE_TTL_CONTENT_SECONDS`) |
| metadata | Bible, book, chapter and verse lists | 1 day (`CACHE_TTL_METADATA_SECONDS`) |
| search | `/search` results | 1 day (`CACHE_TTL_SEARCH_SECONDS`) |
| negative | API.Bible 400 / 403 / 404 | 10 minutes (`CACHE_TTL_NEGATIVE_SECONDS`) |

- **Stale-if-error:** after an entry stops being fresh, it can still be served while API.Bible is down or out of quota, up to `CACHE_STALE_IF_ERROR_SECONDS` (default and maximum 29 days after fetching).
- **29-day ceiling:** every TTL is clamped to 29 days, whatever is configured (API.Bible Terms §11).
- **Audio:** audio chapter responses contain signed URLs, so they're never cached past their `expiresAt` (minus a minute).
- **Client caching:** responses carry `Cache-Control: private, max-age=…`, up to `CLIENT_MAX_AGE_SECONDS` (1 h), plus an `ETag`. A client that sends `If-None-Match` gets `304` when nothing changed.

### Redis (optional)

Redis is used only when `REDIS_URL` is set. It does two jobs: a shared cache, and shared rate-limit counters.

| | With Redis | Without Redis |
|---|---|---|
| **Cache** | Memory first, then Redis. A Redis hit is copied into memory, and new responses go to both. | Memory only: an LRU of `MEMORY_CACHE_MAX_MB` per process. |
| **Entry lifetime in memory** | At most `MEMORY_CACHE_MAX_TTL_SECONDS` (1 h), so purges reach every instance within an hour. | Full lifetime, unless pushed out when memory is full. |
| **Rate limits** | Counted in Redis, shared by all instances. | Counted in memory, per process. |
| **Purge** | Clears Redis and the handling instance's memory. | Clears that process's memory. |
| **`/readyz`** | Pings Redis; `503` if unreachable. | Always ok. |

These always run per process, with or without Redis: merging concurrent requests, paused-key state, and `/admin/stats` counters.

- **One instance (e.g. Render free or starter):** nothing is missing without Redis. The cost is that every restart, deploy or free-tier sleep starts with an empty cache.
- **Several instances:** use Redis. Without it, each instance has its own cache (the same verse is fetched once per instance), and each user's effective limit is multiplied by the number of instances.

**If Redis goes down**, the proxy keeps serving:
- **Startup:** waits up to 5 s for Redis, then starts anyway.
- **Cache:** Redis errors are logged and treated as misses. Calls give up after 1 s, so requests don't stall.
- **Rate limits:** requests are let through rather than blocked.
- **Purge:** fails with `500` rather than half-succeeding. A purge may be an API.Bible removal request.
- **`/readyz`:** returns `503`, so don't use it as the hosting health check; use `/healthz`.

**Purge ALL** deletes every key under `REDIS_KEY_PREFIX`, which also resets the rate-limit counters.

### Authentication

**App users (`/v1`).** Tokens from every accepted project work. A project is accepted when it has a service account file (or is listed in `FIREBASE_PROJECT_IDS`). The token's `aud` claim picks the project, and that project fully verifies the token; other projects get `401`. Rate limits are kept per `project/uid`, so the same uid in two projects never shares a budget. Dev and prod share the cache and the API.Bible quota. To separate them completely, run one deployment per environment, each with only its own service account.

**Admins (`/admin`, debug console).** Only admins of the **admin project** get in. That's `wpa-be-app`: the project in `service-account.json`, unless `FIREBASE_ADMIN_PROJECT_ID` says otherwise. A request is accepted when:

- The ID token is valid and not revoked. Disabled or signed-out admins are rejected.
- The token comes from the admin project. Users of `wpa-be-app-dev` can call `/v1`, but get `403` on `/admin`.
- The user's Firestore profile `users/{uid}` in that project has `is_admin: true`.
- **Email fallback:** if there's no profile under the uid, any profile with the same email and `is_admin: true` counts, but only if the token's email is verified.

A verified admin is cached for 60 s (never past the token's expiry), so removing admin access can take up to a minute to apply. Admin checks use the project's service account.

---

## API

Paths are the same as API.Bible v1. To migrate a client, change the base URL from `https://rest.api.bible/v1` to `https://<proxy>/v1` and send a Firebase ID token instead of `api-key`. Response bodies are passed through unchanged, including `meta.fumsToken`.

| Endpoint | Cache class |
|---|---|
| `GET /v1/bibles` · `/v1/bibles/{bibleId}` | metadata |
| `GET /v1/bibles/{bibleId}/books[/{bookId}[/chapters\|/sections]]` | metadata |
| `GET /v1/bibles/{bibleId}/chapters/{chapterId}` | content |
| `GET /v1/bibles/{bibleId}/chapters/{chapterId}/sections\|verses` | metadata |
| `GET /v1/bibles/{bibleId}/passages/{passageId}` | content |
| `GET /v1/bibles/{bibleId}/sections/{sectionId}` | content |
| `GET /v1/bibles/{bibleId}/verses/{verseId}` | content |
| `GET /v1/bibles/{bibleId}/search?query=…` | search |
| `GET /v1/audio-bibles[/{id}[/books[/{bookId}[/chapters]]]]` | metadata |
| `GET /v1/audio-bibles/{id}/chapters/{chapterId}` | content (capped at the signed URL's `expiresAt`) |

Each route accepts only the query parameters API.Bible documents for it (see `src/routes.js`). Anything else returns `400`.

### Choosing a Bible version

The version is the `{bibleId}` in the path. There's no server-side default. For example, `de4e12af7f28f599-02` is the King James Version.

1. **Find the ID:** list the Bibles your key can use, optionally filtered by `language`, `abbreviation`, `name` or `ids`:
   ```bash
   curl -H "Authorization: Bearer $ID_TOKEN" "https://<proxy>/v1/bibles?language=eng&abbreviation=KJV"
   ```
   Each entry in `data` has `id`, `abbreviation` and `name`. In the debug console, **Load bible list** fills the Bible ID suggestions.
2. **Use it in every request:** `/v1/bibles/{bibleId}/verses/JHN.3.16`. References such as `JHN.3.16` or `GEN.1` are the same in every version.

You only get versions your API.Bible plan is licensed for. Others return `403`.

### Response headers

`X-Cache: HIT | MISS | STALE`, `Age`, `ETag`, `Cache-Control: private, max-age=…` (`no-cache` for stale copies), and `Retry-After` on `429`/`503`.

### Errors

Errors use API.Bible's shape: `{ "statusCode": 401, "error": "Unauthorized", "message": "…" }`.

| Status | Meaning |
|---|---|
| 400 | Invalid path ID, or an unsupported or repeated query parameter |
| 401 | Missing, invalid or expired ID token, token from a project that isn't accepted, or App Check failure |
| 403 | Anonymous user (when not allowed), Bible not licensed for your keys, or (on `/admin`) not an admin of the admin project |
| 404 | Unknown route, or API.Bible returned 404 |
| 429 | Per-user limit hit (see `Retry-After`) |
| 502 | API.Bible unreachable, and no cached copy |
| 503 | Every API key is rate-limited or out of quota, and no cached copy (see `Retry-After`); on `/admin`, the Firestore admin lookup failed |

### Admin endpoints

All need an admin's ID token (see [Authentication](#authentication)).

| Endpoint | |
|---|---|
| `GET /admin/whoami` | `{ uid, email, projectId }` of the signed-in admin |
| `GET /admin/stats` | cache counters, API.Bible call count, masked key status |
| `POST /admin/cache/purge` | `{"all": true}`, `{"bibleId": "…"}` or `{"audioBibleId": "…"}` |
| `GET /admin/routes` | the route allowlist |
| `GET /admin/v1/…` | same as `/v1/…` without the client checks (App Check, anonymous users). Still cached and rate limited. |

### Debug console

Open `https://<proxy>/debug/`. Only the static page and `/debug/firebase-config` are public.

**Sign-in works like wpa-be-admin.** The page loads the admin project's Firebase web config from the server (`/debug/firebase-config`, the counterpart of wpa-be-admin's `/api/firebase-config`). You enter only your email and password; nobody types an API key. The console unlocks after `/admin/whoami` confirms you're an admin. If the server has no web config for the admin project, the page says so, and you can paste an admin ID token instead.

What it offers:

- **Request builder:** built from the route allowlist, with presets (including requests that should fail), a Bible ID picker and an editable URL.
- **Auth modes:**
  - *Client auth:* `/v1` with your token, or a pasted app-user token (from either project), plus App Check.
  - *No auth:* expect `401`.
  - *Skip client auth:* `/admin/v1`.
- **Response view:** status, timing, cache headers, all headers, the formatted body, `meta.fumsToken`, and a history list.
- **Debugging tools:**
  - Send `If-None-Match` to test `304`s.
  - Copy any request as curl.
  - **Burst** sends N identical requests at once and reports how many API.Bible calls they cost, which shows request merging working.
- **Cache & keys:** live stats and cache purge.
- **Session:** identity, token expiry (auto-refreshed) and decoded claims.

The page has a strict Content Security Policy: scripts may only talk to the proxy and the Firebase Auth REST endpoints. Response data is never rendered as HTML. Tokens are kept in `sessionStorage`, so they're gone when the tab closes.

### Ops endpoints

- `GET /healthz`: liveness, no auth. Use this as the hosting health check.
- `GET /readyz`: readiness, no auth. `503` if Redis is configured but unreachable.

---

## Client usage

```js
import { getAuth } from 'firebase/auth';

const PROXY = 'https://wpa-be-bible-proxy.onrender.com/v1';

export async function getPassage(bibleId, passageId) {
  const token = await getAuth().currentUser.getIdToken(); // the SDK refreshes it automatically
  const res = await fetch(`${PROXY}/bibles/${bibleId}/passages/${passageId}?content-type=text`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error((await res.json()).message);
  const { data, meta } = await res.json();
  window.fums?.('trackView', meta.fumsToken); // web apps must report FUMS (API.Bible Terms §3.3, §14)
  return data;
}
```

On mobile (Flutter/iOS/Android), get the token with `user.getIdToken()` and send the same header. With App Check on, also send `X-Firebase-AppCheck: <token>`. On Render's free tier, give the first request a generous timeout (60 s) or retry once, because of cold starts.

**FUMS:** API.Bible requires **web** apps to report each response's `meta.fumsToken` with `https://pkg.api.bible/fumsV3.min.js`; mobile-only apps are exempt. Cached responses repeat the token from the original fetch, so views are reported but tied to that first request. If exact attribution matters for your licence, confirm with support@api.bible.

---

## Configuration

### Environment variables

Only `API_BIBLE_KEYS` is required. [`.env.example`](.env.example) lists every variable with its default. The ones you're most likely to set:

| Variable | Default | Purpose |
|---|---|---|
| `API_BIBLE_KEYS` | (required) | API.Bible key(s), comma-separated; the first is primary |
| `ALLOW_ANONYMOUS_USERS` | `false` | allow Firebase Anonymous Auth users |
| `FIREBASE_REQUIRE_APP_CHECK` | `false` | require `X-Firebase-AppCheck` |
| `FIREBASE_CHECK_REVOKED` | `false` | reject revoked/disabled users on every `/v1` call (extra Firebase round-trip). Admin requests always check. |
| `FIREBASE_ADMIN_PROJECT_ID` | prod service account's project | the only project whose admins may use `/admin` |
| `FIREBASE_PROJECT_IDS` | | extra accepted projects without a service account |
| `CORS_ORIGINS` | (off) | browser origins allowed to call the API (only needed for web clients on other domains) |
| `REDIS_URL` | (off) | enables the shared Redis cache and rate limits |
| `MEMORY_CACHE_MAX_MB` | `128` | in-process cache size (use `64` on 512 MB instances) |
| `RATE_LIMIT_REQUESTS_PER_MINUTE` | `300` | per user, all requests |
| `RATE_LIMIT_UPSTREAM_PER_MINUTE` | `30` | per user, cache misses only |
| `CACHE_TTL_*_SECONDS` | see [Caching](#caching) | freshness per cache class |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Render sets `PORT` itself |

### Firebase files

The same three files as wpa-be-admin:

| File | Contents |
|---|---|
| `service-account.json` | `wpa-be-app` (prod) service account key: Firebase console → Project settings → Service accounts → Generate new private key |
| `service-account-dev.json` | `wpa-be-app-dev` service account key |
| `firebase-client-config.json` | the web config the debug console signs in with: Firebase console → Project settings → Your apps → Web app. The prod config object, or an array that includes it. |

- **Lookup order** (as in wpa-be-admin):
  1. `/etc/secrets/<file>` (Render Secret Files, the docker compose mount)
  2. an env var holding the JSON (`FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_SERVICE_ACCOUNT_DEV`, `FIREBASE_CLIENT_CONFIG`)
  3. `src/config/<file>`
- **What they do:** each service account's project becomes an accepted project for `/v1`, and its credentials power the admin checks. Only the admin project's web config is sent to the console.
- **Keep them private:** the files are gitignored and excluded from the Docker image.
- **Startup checks:** the server refuses to start if a file is malformed, if both service accounts are for the same project, if the web config is for a project that isn't accepted, or if `FIREBASE_ADMIN_PROJECT_ID` isn't accepted. Errors name the file but never print its contents. A missing web config only logs a warning (the console then can't sign in).

---

## Running locally

Requires Node 22.9 or newer (24 recommended).

```bash
npm install
cp .env.example .env   # fill in API_BIBLE_KEYS
# put service-account.json, service-account-dev.json, firebase-client-config.json in src/config/
npm run dev            # node --watch; http://localhost:8080/debug/
npm test               # unit + HTTP tests (no network or Firebase needed)
TEST_REDIS_URL=redis://localhost:6379 npm test   # also run the Redis integration tests

docker compose up --build   # proxy + Redis; src/config is mounted at /etc/secrets
```

To use the Firebase Auth Emulator, set `FIREBASE_AUTH_EMULATOR_HOST=localhost:9099`.

---

## Hosting on Render

### What you need

- [ ] The code in a **GitHub or GitLab repository** Render can access. The Firebase files and `.env` are gitignored, so they won't be pushed.
- [ ] An **API.Bible key** (or several, comma-separated).
- [ ] The **three Firebase files**: `service-account.json`, `service-account-dev.json`, `firebase-client-config.json`.
- [ ] A **Render account**.

The repo already contains what Render needs:
- `render.yaml`: the Blueprint. It defines a Node web service with `npm ci --omit=dev` to build, `node src/server.js` to start, `/healthz` as the health check, and the environment variables.
- `.node-version`: pins Node 24.
- The server already listens on Render's `PORT`, trusts Render's proxy headers, and shuts down cleanly when Render stops it.

### Deploy

1. **Push the repo**, without the Firebase files.
2. **Create the service from the Blueprint:** Render dashboard → **New** → **Blueprint** → pick the repo. Render reads `render.yaml` and asks for `API_BIBLE_KEYS`. Keep the service name `wpa-be-bible-proxy`, or change it in `render.yaml` first; it becomes `https://<name>.onrender.com`.
3. **Add the Firebase files as Secret Files:** service → **Environment** → **Secret Files** → add each one, with the file name exactly as above and the JSON pasted as the contents. Render mounts them at `/etc/secrets/`, the first place the proxy looks. Secret Files can't go in `render.yaml`, so this step is always manual.
4. **Deploy:** saving the Secret Files offers a deploy; otherwise use **Manual Deploy** → **Deploy latest commit**.
5. **Check it:** see [Verify the deployment](#verify-the-deployment).

Without a Blueprint, create a **Web Service** by hand with:
- **Runtime:** Node
- **Build command:** `npm ci --omit=dev`
- **Start command:** `node src/server.js`
- **Health check path:** `/healthz`
- the environment variables below

Use `node src/server.js` as the start command rather than `npm start`. Render provides env vars directly, so the `.env` loading in `npm start` isn't needed.

### Environment variables on Render

`render.yaml` sets:

| Variable | Value | Notes |
|---|---|---|
| `API_BIBLE_KEYS` | (prompted) | stored encrypted by Render; never commit it |
| `NODE_ENV` | `production` | |
| `MEMORY_CACHE_MAX_MB` | `64` | free and starter instances have 512 MB RAM |
| `LOG_LEVEL` | `info` | |
| `ALLOW_ANONYMOUS_USERS` | `false` | set `true` if the app uses Firebase Anonymous Auth |

Don't set `PORT`; Render provides it. Changing a variable in the dashboard redeploys the service.

### Free tier or paid

`render.yaml` uses `plan: free`. On the free tier, as of when this was written (check [render.com/docs/free](https://render.com/docs/free)):

- **Sleep:** the service spins down after ~15 minutes without requests. The next request waits for it to start again, often 30–60 s, and a mobile app may time out first.
- **Cache loss:** the in-memory cache is lost on every sleep and deploy, so the first requests afterwards go to API.Bible.
- **Hours:** ~750 free instance hours per workspace per month, enough for one service running all month.

Options:
1. **Keep it awake:** an external uptime monitor (e.g. UptimeRobot) calls `https://<name>.onrender.com/healthz` every 10 minutes. Check Render's current terms before relying on this.
2. **Upgrade to starter (paid):** always on, and the cache survives between requests. Change `plan:` in `render.yaml` or in the dashboard. Recommended once real users depend on it.
3. **Accept the cold starts:** fine for testing. Give the app's first request a long timeout or a retry.

### Adding Redis (optional)

For a single instance this isn't needed (see [Redis](#redis-optional)). To add it, uncomment the `keyvalue` service and the `REDIS_URL` entry in `render.yaml` and sync the Blueprint. Render then creates a Key Value instance in the same region and passes its internal URL to the proxy. The free Key Value plan is small and may not keep data across restarts.

### Verify the deployment

1. `curl https://<name>.onrender.com/healthz` → `{"status":"ok"}`.
2. In the service **Logs**, the startup line `WPA BE Bible Proxy ready` should show:
   - `firebaseProjects: ["wpa-be-app", "wpa-be-app-dev"]`
   - `adminProject: "wpa-be-app"`
   - `firebaseConfig` sources under `/etc/secrets/`
3. Open `https://<name>.onrender.com/debug/`, sign in with a wpa-be-app admin account, and send the **Verse JHN.3.16** preset. The first send should say `MISS`, the second `HIT`.
4. Point the app at `https://<name>.onrender.com/v1`.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| Deploy fails with `Invalid configuration: API_BIBLE_KEYS` | the variable is missing or empty |
| Deploy fails with `Invalid Firebase configuration` | a Secret File is malformed, has the wrong name, or both service accounts are for the same project. The message names the file. |
| Console says sign-in isn't set up | `firebase-client-config.json` is missing, or has no entry for wpa-be-app |
| Sign-in says the apiKey is invalid, or "requests from this referer are blocked" | the Firebase web API key is restricted to certain websites. Add `https://<name>.onrender.com/*` in Google Cloud console → APIs & Services → Credentials. |
| Console says "Admin access requires a wpa-be-app account" | you signed in with a wpa-be-app-dev account |
| Console says "This account is not an admin" | `users/{uid}` in wpa-be-app lacks `is_admin: true`. With the email fallback, the email must be verified. |
| Console says "Could not verify admin status" | Firestore lookup failed; check the logs and the prod service account |
| App users get `401` | token from a project with no service account, or an expired token |
| First request after a while is very slow | free-tier cold start (see [Free tier or paid](#free-tier-or-paid)) |
| `403` for one Bible version | that version isn't licensed for your API.Bible key |

---

## Other hosts

The `Dockerfile` builds a production image (`node:24-alpine`, production dependencies only, runs as `node`, port 8080). Provide the Firebase files at `/etc/secrets/` or as the `FIREBASE_*` env vars, and set `API_BIBLE_KEYS`. On Google Cloud Run, for example, keep the keys and Firebase JSON in Secret Manager and expose them as env vars:

```bash
gcloud run deploy wpa-be-bible-proxy --source . \
  --set-secrets API_BIBLE_KEYS=api-bible-keys:latest,FIREBASE_SERVICE_ACCOUNT=sa-prod:latest,FIREBASE_SERVICE_ACCOUNT_DEV=sa-dev:latest,FIREBASE_CLIENT_CONFIG=firebase-client-config:latest
```

Running more than one instance? Add Redis (see [Redis](#redis-optional)).

## Rotating API keys

1. Set `API_BIBLE_KEYS=new,old` and deploy. Traffic moves to the new key.
2. Revoke the old key in the API.Bible dashboard.
3. Set `API_BIBLE_KEYS=new` and deploy.

API.Bible allows one free-tier account per entity (Terms §9.6). Multiple keys are for rotation and paid-plan failover, not for stacking free quotas.
