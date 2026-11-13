// WPA BE Bible Proxy debug console. Plain ES module, no build step.
//
// Access: admin sign-in. The console unlocks only after GET /admin/whoami succeeds, i.e. the
// server verified the ID token (with revocation check) and found users/{uid}.is_admin === true.
// Everything derived from responses is rendered with textContent (never innerHTML): Bible
// content contains HTML, and the page runs with a strict CSP.

const $ = (sel) => document.querySelector(sel);
const KJV = 'de4e12af7f28f599-02';

/** Tiny DOM builder: el('td', { class: 'x' }, 'text', childNode) */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== undefined && c !== null) node.append(c instanceof Node ? c : String(c));
  return node;
}

function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast('Clipboard unavailable (needs https or localhost)');
  }
}

/** Disable a button while an async action runs; surface errors as toasts. */
function busy(button, fn) {
  return async (...args) => {
    button.disabled = true;
    button.classList.add('busy');
    try {
      await fn(...args);
    } catch (e) {
      toast(`Error: ${e.message}`, 5000);
      console.error(e);
    } finally {
      button.disabled = false;
      button.classList.remove('busy');
    }
  };
}

// =============================================================================
// Admin session (Firebase Auth REST API; tokens in sessionStorage, gone when the tab closes)
// =============================================================================

const session = JSON.parse(sessionStorage.getItem('bp.session') || '{}');
const saveSession = () => sessionStorage.setItem('bp.session', JSON.stringify(session));

function decodeJwt(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));
  } catch {
    return null;
  }
}

function setSession(idToken, refreshToken = null, apiKey = null) {
  Object.assign(session, { idToken, refreshToken, apiKey });
  saveSession();
}

function clearSession() {
  for (const k of Object.keys(session)) delete session[k];
  saveSession();
}

async function firebaseRest(url, init) {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

async function refreshToken() {
  if (!session.refreshToken || !session.apiKey) throw new Error('This session cannot be refreshed (pasted token)');
  const json = await firebaseRest(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(session.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
  });
  setSession(json.id_token, json.refresh_token, session.apiKey);
}

/** Admin ID token, refreshed automatically when it expires within a minute. */
async function adminToken() {
  if (!session.idToken) return null;
  const exp = decodeJwt(session.idToken)?.exp;
  if (exp && exp * 1000 - Date.now() < 60_000 && session.refreshToken) {
    try {
      await refreshToken();
    } catch (e) {
      toast(`Token refresh failed: ${e.message}`, 5000);
    }
  }
  return session.idToken;
}

// =============================================================================
// HTTP
// =============================================================================

const lastEtag = new Map(); // url -> etag
const history = [];

async function request(method, url, { body, token, appCheck, withEtag = false } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (appCheck) headers['x-firebase-appcheck'] = appCheck;
  if (withEtag && lastEtag.has(url)) headers['if-none-match'] = lastEtag.get(url);
  if (body !== undefined) headers['content-type'] = 'application/json';

  const t0 = performance.now();
  const r = { method, url, at: new Date(), sent: Object.keys(headers) };
  try {
    // no-store: bypass the browser's HTTP cache so every request really reaches the proxy.
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    r.text = await res.text();
    r.status = res.status;
    r.statusText = res.statusText;
    r.headers = [...res.headers];
  } catch (e) {
    r.status = 0;
    r.statusText = 'network error';
    r.text = String(e);
    r.headers = [];
  }
  r.ms = Math.round(performance.now() - t0);
  const etag = header(r, 'etag');
  if (r.status === 200 && etag) lastEtag.set(url, etag);
  return r;
}

/** Call an /admin endpoint. On 401 refresh once; if still rejected, go back to sign-in. */
async function adminRequest(method, url, body) {
  let r = await request(method, url, { body, token: await adminToken() });
  if (r.status === 401 && session.refreshToken) {
    try {
      await refreshToken();
      r = await request(method, url, { body, token: session.idToken });
    } catch {}
  }
  if (r.status === 401) showLogin('Your admin session expired or was revoked. Sign in again.');
  return r;
}

const header = (r, name) => r.headers.find(([k]) => k === name)?.[1];
const safeMessage = (r) => {
  try {
    return JSON.parse(r.text).message;
  } catch {
    return r.statusText;
  }
};

function statusClass(status) {
  if (status >= 200 && status < 400) return 'ok';
  if (status === 429 || status === 503) return 'warn';
  return 'err';
}

const CACHE_CLASS = { HIT: 'ok', MISS: 'warn', STALE: 'err' };
const HIGHLIGHT = new Set(['x-cache', 'age', 'etag', 'cache-control', 'retry-after', 'www-authenticate', 'content-encoding']);

// =============================================================================
// Sign-in gate
// =============================================================================

let consoleReady = false;

function showLogin(message = '') {
  clearSession();
  $('#console').classList.add('hidden');
  $('#whoami').classList.add('hidden');
  $('#signout').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#login-error').textContent = message;
  $('#login-error').classList.toggle('hidden', !message);
}

/** Ask the server whether the current token belongs to an admin; open the console if so. */
async function enterConsole() {
  const r = await request('GET', '/admin/whoami', { token: await adminToken() });
  const notAdminProject = r.status === 403 && /requires a .+ account/.test(safeMessage(r));
  const reasons = {
    0: 'Could not reach the proxy.',
    401: 'Token rejected: invalid, expired, revoked, or from a Firebase project this proxy does not accept.',
    403: notAdminProject ? safeMessage(r) : 'This account is not an admin. Its Firestore profile users/{uid} needs is_admin: true.',
    503: 'Could not verify admin status (Firestore lookup failed). Check the proxy logs and its Google credentials.',
  };
  if (r.status !== 200) return showLogin(reasons[r.status] ?? `Unexpected response: ${r.status} ${safeMessage(r)}`);

  const me = JSON.parse(r.text);
  $('#whoami').textContent = `${me.email ?? me.uid} · ${me.projectId ?? '?'}`;
  for (const id of ['#whoami', '#signout', '#console']) $(id).classList.remove('hidden');
  $('#login-screen').classList.add('hidden');
  if (!consoleReady) {
    consoleReady = true;
    await initRequestBuilder();
  }
  renderSession();
}

/**
 * The admin project's Firebase web config, loaded from the server like wpa-be-admin's
 * /api/firebase-config (src/config/firebase-client-config.json). The user only types an email and password.
 */
let signInProject = null;

/** Firebase Auth REST error codes → the messages the Firebase SDK would show. */
const SIGNIN_ERRORS = {
  INVALID_LOGIN_CREDENTIALS: 'Incorrect email or password.',
  INVALID_PASSWORD: 'Incorrect email or password.',
  EMAIL_NOT_FOUND: 'Incorrect email or password.',
  INVALID_EMAIL: 'Enter a valid email address.',
  USER_DISABLED: 'This account has been disabled.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many failed attempts. Try again later or reset your password.',
  PASSWORD_LOGIN_DISABLED: 'Email/password sign-in is turned off for this Firebase project.',
  OPERATION_NOT_ALLOWED: 'Email/password sign-in is turned off for this Firebase project.',
};

function signInError(message) {
  const code = message.split(/[\s:]/)[0];
  if (SIGNIN_ERRORS[code]) return SIGNIN_ERRORS[code];
  if (/API key not valid|API_KEY_INVALID/i.test(message)) return 'The server\'s Firebase web config has an invalid apiKey.';
  return message;
}

async function signIn(e) {
  e.preventDefault();
  const project = signInProject;
  const email = $('#signin-email').value.trim();
  const password = $('#signin-password').value;
  if (!project) throw new Error('Sign-in is not configured on this server');
  if (!email || !password) throw new Error('Email and password are required');
  localStorage.setItem('bp.email', email);
  let json;
  try {
    json = await firebaseRest(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(project.apiKey)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) },
    );
  } catch (err) {
    return showLogin(`Failed to log in: ${signInError(err.message)}`);
  } finally {
    $('#signin-password').value = '';
  }
  setSession(json.idToken, json.refreshToken, project.apiKey);
  await enterConsole();
}

async function initLogin() {
  for (const k of ['bp.apiKey', 'bp.project']) localStorage.removeItem(k); // left over from the old form
  try {
    const res = await fetch('/debug/firebase-config', { cache: 'no-store' });
    signInProject = res.ok ? ((await res.json()).projects ?? [])[0] ?? null : null;
  } catch {
    signInProject = null;
  }
  if (signInProject) {
    $('#signin-project').textContent = signInProject.projectId;
  } else {
    $('#signin-form').classList.add('hidden');
    $('#signin-unconfigured').classList.remove('hidden');
    $('#token-details').open = true;
  }
  $('#signin-email').value = localStorage.getItem('bp.email') || '';
  $('#signin-form').addEventListener('submit', busy($('#signin-go'), signIn));
  $('#token-use').addEventListener(
    'click',
    busy($('#token-use'), async () => {
      const t = $('#token-input').value.trim().replace(/^Bearer\s+/i, '');
      if (!t) throw new Error('Paste a token first');
      $('#token-input').value = '';
      setSession(t);
      await enterConsole();
    }),
  );
  $('#signout').addEventListener('click', () => showLogin());
}

function renderSession() {
  if (!session.idToken) return;
  const c = decodeJwt(session.idToken) ?? {};
  const secsLeft = Math.floor((c.exp ?? 0) - Date.now() / 1000);
  const left = secsLeft <= 0 ? 'EXPIRED' : `${Math.floor(secsLeft / 60)}m ${String(secsLeft % 60).padStart(2, '0')}s`;
  const box = $('#auth-status');
  box.className = `auth-status ${secsLeft <= 0 ? 'err' : secsLeft < 300 ? 'warn' : 'ok'}`;
  box.replaceChildren(
    el('div', {}, el('strong', {}, c.email || c.sub || '?'), ' (admin)'),
    el('div', { class: 'small' }, `project (aud): ${c.aud}`),
    el('div', { class: 'small' }, `uid: ${c.user_id || c.sub} · provider: ${c.firebase?.sign_in_provider ?? '?'}`),
    el('div', { class: 'small' }, `token expires in: ${left}${session.refreshToken ? ' (auto-refresh on)' : ' (pasted, no refresh)'}`),
  );
  $('#claims').textContent = JSON.stringify(c, null, 2);
  $('#token-refresh').disabled = !session.refreshToken;
}

function initSessionPanel() {
  $('#token-refresh').addEventListener('click', busy($('#token-refresh'), async () => (await refreshToken(), renderSession(), toast('Token refreshed'))));
  $('#token-copy').addEventListener('click', () => copy(session.idToken, 'Admin ID token copied'));
  setInterval(renderSession, 1000);
}

// =============================================================================
// Request builder
// =============================================================================

let routes = [];

const PARAM_EXAMPLES = {
  bibleId: KJV,
  audioBibleId: '105a06b6146d11e7-01',
  bookId: 'JHN',
  chapterId: 'JHN.3',
  verseId: 'JHN.3.16',
  passageId: 'JHN.3.16-JHN.3.18',
  sectionId: 'JHN.S1',
};

const BOOL = ['true', 'false'];
const QUERY_SUGGESTIONS = {
  'content-type': ['html', 'json', 'text'],
  sort: ['relevance', 'canonical', 'reverse-canonical'],
  fuzziness: ['AUTO', '0', '1', '2'],
  language: ['eng', 'spa', 'fra', 'por'],
  limit: ['10', '25', '100'],
};
const suggestionsFor = (name) =>
  QUERY_SUGGESTIONS[name] ?? (name.startsWith('include-') || name === 'use-org-id' || name === 'parallels' ? BOOL : null);

const PRESETS = [
  { label: 'Bibles (eng)', path: '/bibles', query: { language: 'eng' } },
  { label: 'Verse JHN.3.16', path: '/bibles/:bibleId/verses/:verseId', params: { verseId: 'JHN.3.16' }, query: { 'content-type': 'text' } },
  { label: 'Passage JHN.3.16-18', path: '/bibles/:bibleId/passages/:passageId', params: { passageId: 'JHN.3.16-JHN.3.18' }, query: { 'content-type': 'text' } },
  { label: 'Chapter GEN.1', path: '/bibles/:bibleId/chapters/:chapterId', params: { chapterId: 'GEN.1' } },
  { label: 'Books', path: '/bibles/:bibleId/books' },
  { label: 'Search "love one another"', path: '/bibles/:bibleId/search', query: { query: 'love one another', limit: '10' } },
  { label: '✗ unknown param (400)', path: '/bibles/:bibleId/verses/:verseId', params: { verseId: 'JHN.3.16' }, suffix: '?nonce=123' },
  { label: '✗ bad id (400)', path: '/bibles/:bibleId/verses/:verseId', params: { verseId: 'JHN.3.16' }, suffix: '%2F..%2Fx' },
  { label: '✗ not found (404)', path: '/bibles/:bibleId/verses/:verseId', params: { verseId: 'XYZ.99.99' } },
];

const currentRoute = () => routes[$('#route').selectedIndex];
const authMode = () => $('#auth-mode').value;

function renderRouteInputs(values = {}) {
  const route = currentRoute();
  $('#route-class').value = route.cacheClass;
  const paramNames = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);

  $('#params').replaceChildren(
    ...paramNames.map((name) =>
      el(
        'label',
        {},
        `:${name}`,
        el('input', {
          'data-param': name,
          class: 'mono',
          spellcheck: 'false',
          list: name === 'bibleId' ? 'bible-ids' : undefined,
          placeholder: PARAM_EXAMPLES[name] ?? '',
          value: values.params?.[name] ?? (name === 'bibleId' ? localStorage.getItem('bp.bibleId') || KJV : PARAM_EXAMPLES[name] ?? ''),
          oninput: buildUrl,
        }),
      ),
    ),
  );

  $('#query').replaceChildren(
    ...route.query.map((name) => {
      const options = suggestionsFor(name);
      const listId = options ? `dl-${name}` : undefined;
      return el(
        'label',
        {},
        `?${name}`,
        el('input', { 'data-query': name, class: 'mono', spellcheck: 'false', list: listId, value: values.query?.[name] ?? '', oninput: buildUrl }),
        options ? el('datalist', { id: listId }, options.map((o) => el('option', { value: o }))) : null,
      );
    }),
  );
  buildUrl();
}

function buildUrl() {
  const route = currentRoute();
  const path = route.path.replace(/:([A-Za-z]+)/g, (_, name) => {
    const v = document.querySelector(`[data-param="${name}"]`)?.value.trim();
    if (name === 'bibleId' && v) localStorage.setItem('bp.bibleId', v);
    return v ? encodeURIComponent(v) : `:${name}`;
  });
  const qs = new URLSearchParams();
  for (const input of document.querySelectorAll('[data-query]')) if (input.value.trim()) qs.set(input.dataset.query, input.value.trim());
  $('#url').value = `/v1${path}${qs.size ? `?${qs}` : ''}`;
}

function applyPreset(p) {
  $('#route').selectedIndex = routes.findIndex((r) => r.path === p.path);
  renderRouteInputs({ params: p.params, query: p.query });
  if (p.suffix) $('#url').value += p.suffix;
}

/** Where and how to send a /v1 path, according to the selected auth mode. */
async function target(path) {
  if (!path.startsWith('/v1/')) throw new Error('URL must start with /v1/');
  switch (authMode()) {
    case 'admin':
      return { url: `/admin${path}`, token: await adminToken() };
    case 'none':
      return { url: path };
    default:
      return {
        url: path,
        token: $('#client-token').value.trim().replace(/^Bearer\s+/i, '') || (await adminToken()),
        appCheck: $('#appcheck').value.trim() || undefined,
      };
  }
}

function showResponse(r) {
  $('#resp-summary').textContent = `${r.method} ${r.url} → ${r.status} ${r.statusText} · ${r.ms} ms · ${r.text.length.toLocaleString()} chars`;

  const xCache = header(r, 'x-cache');
  const badges = [el('span', { class: `badge ${statusClass(r.status)}` }, `${r.status} ${r.statusText}`)];
  if (xCache) badges.push(el('span', { class: `badge ${CACHE_CLASS[xCache] ?? ''}` }, `X-Cache: ${xCache}`));
  if (header(r, 'age')) badges.push(el('span', { class: 'badge' }, `Age: ${header(r, 'age')}s`));
  if (header(r, 'retry-after')) badges.push(el('span', { class: 'badge warn' }, `Retry-After: ${header(r, 'retry-after')}s`));
  badges.push(el('span', { class: 'badge' }, `${r.ms} ms`));
  badges.push(el('span', { class: 'muted small' }, `sent: ${r.sent.join(', ') || '(no auth headers)'}`));
  $('#resp-badges').replaceChildren(...badges);

  $('#resp-headers').replaceChildren(
    ...r.headers.map(([k, v]) => el('tr', { class: HIGHLIGHT.has(k) ? 'hl' : '' }, el('td', {}, k), el('td', {}, v))),
  );

  let pretty = r.text || '(empty body)';
  let fums = '';
  try {
    const json = JSON.parse(r.text);
    pretty = JSON.stringify(json, null, 2);
    if (json?.meta?.fumsToken) fums = `meta.fumsToken: ${json.meta.fumsToken}`;
  } catch {}
  $('#resp-body').textContent = pretty;
  $('#resp-fums').textContent = fums;
}

function addHistory(r) {
  history.unshift(r);
  history.length = Math.min(history.length, 50);
  $('#history tbody').replaceChildren(
    ...history.map((h) =>
      el(
        'tr',
        { onclick: () => (showResponse(h), $('#burst-result').classList.add('hidden')) },
        el('td', {}, h.at.toLocaleTimeString()),
        el('td', { class: statusClass(h.status) }, h.status),
        el('td', { class: CACHE_CLASS[header(h, 'x-cache')] ?? '' }, header(h, 'x-cache') ?? ''),
        el('td', {}, h.ms),
        el('td', {}, `${h.method} ${h.url}`),
      ),
    ),
  );
}

function populateBibleList(r) {
  try {
    const bibles = JSON.parse(r.text).data;
    if (!Array.isArray(bibles)) return;
    $('#bible-ids').replaceChildren(
      ...bibles.map((b) => el('option', { value: b.id }, `${b.abbreviationLocal || b.abbreviation} · ${b.name} (${b.language?.id ?? '?'})`)),
    );
    toast(`${bibles.length} bibles loaded into the Bible ID suggestions`);
  } catch {}
}

async function send() {
  const t = await target($('#url').value.trim());
  const r = await request('GET', t.url, { ...t, withEtag: $('#send-etag').checked });
  $('#burst-result').classList.add('hidden');
  showResponse(r);
  addHistory(r);
  if (r.status === 200 && /^(\/admin)?\/v1\/bibles(\?|$)/.test(t.url)) populateBibleList(r);
}

async function stats() {
  const r = await adminRequest('GET', '/admin/stats');
  return r.status === 200 ? JSON.parse(r.text) : null;
}

async function burst() {
  const n = Math.max(2, Math.min(200, Number($('#burst-n').value) || 20));
  const t = await target($('#url').value.trim()); // token resolved once, not N times
  const before = await stats();
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: n }, () => request('GET', t.url, t)));
  const wall = Math.round(performance.now() - t0);
  const after = before ? await stats() : null;

  const counts = {};
  for (const r of results) {
    const k = `${r.status} ${header(r, 'x-cache') ?? ''}`.trim();
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))];

  const lines = [
    el('div', {}, el('strong', {}, `Burst of ${n} concurrent requests`), ` · wall ${wall} ms · min ${times[0]} / p50 ${pct(50)} / p95 ${pct(95)} / max ${times.at(-1)} ms`),
    el('div', { class: 'row' }, Object.entries(counts).map(([k, v]) => el('span', { class: `badge ${statusClass(Number(k.split(' ')[0]))}` }, `${v} × ${k}`))),
  ];
  if (before && after) {
    const d = (k) => after.cache[k] - before.cache[k];
    const up = after.upstream.requests - before.upstream.requests;
    lines.push(
      el(
        'div',
        { class: up <= 1 ? 'ok' : 'warn' },
        `API.Bible calls: +${up} · coalesced: +${d('coalesced')} · hits: +${d('hits')} · misses: +${d('misses')} · throttled: +${d('userThrottled')}`,
      ),
      el(
        'div',
        { class: 'muted small' },
        'Coalesced requests are labelled MISS in their headers; the API.Bible call count is the real measure. ' +
          'Browsers open at most ~6 connections per host over HTTP/1.1, so later requests usually arrive after the first fetch finished and show HIT.',
      ),
    );
  }
  $('#burst-result').replaceChildren(el('pre', {}, lines));
  $('#burst-result').classList.remove('hidden');
  showResponse(results[0]);
  addHistory(results[0]);
}

async function copyCurl() {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const t = await target($('#url').value.trim());
  const parts = [`curl -i ${q(location.origin + t.url)}`];
  if (t.token) parts.push(`-H ${q(`Authorization: Bearer ${t.token}`)}`);
  if (t.appCheck) parts.push(`-H ${q(`X-Firebase-AppCheck: ${t.appCheck}`)}`);
  if ($('#send-etag').checked && lastEtag.has(t.url)) parts.push(`-H ${q(`If-None-Match: ${lastEtag.get(t.url)}`)}`);
  copy(parts.join(' \\\n  '), t.token ? 'curl copied (contains an ID token)' : 'curl copied');
}

function initAuthMode() {
  const select = $('#auth-mode');
  const saved = localStorage.getItem('bp.authMode');
  if (saved && select.querySelector(`option[value="${saved}"]`)) select.value = saved;
  const hints = {
    client: 'Same path and checks as the mobile/web app (App Check and anonymous-user rules apply).',
    none: 'No credentials are sent; the proxy should answer 401.',
    admin:
      'Calls /admin/v1/… with your admin token: no App Check or anonymous-user checks, so you are testing the proxy, its cache and API.Bible itself. Still cached and rate limited; misses spend real API.Bible quota.',
  };
  const update = () => {
    localStorage.setItem('bp.authMode', select.value);
    $('#auth-mode-hint').textContent = hints[select.value];
    $('#client-token-wrap').classList.toggle('hidden', select.value !== 'client');
  };
  select.addEventListener('change', update);
  update();
}

async function initRequestBuilder() {
  const r = await adminRequest('GET', '/admin/routes');
  if (r.status !== 200) throw new Error(`Could not load routes: ${r.status}`);
  routes = JSON.parse(r.text);
  $('#route').replaceChildren(...routes.map((rt) => el('option', {}, `GET /v1${rt.path}`)));
  $('#route').addEventListener('change', () => renderRouteInputs());
  $('#presets').replaceChildren(...PRESETS.map((p) => el('button', { class: 'secondary', onclick: () => applyPreset(p) }, p.label)));
  applyPreset(PRESETS[1]);
  initAuthMode();

  $('#send').addEventListener('click', busy($('#send'), send));
  $('#url').addEventListener('keydown', (e) => e.key === 'Enter' && $('#send').click());
  $('#burst').addEventListener('click', busy($('#burst'), burst));
  $('#curl').addEventListener('click', busy($('#curl'), copyCurl));
  $('#body-copy').addEventListener('click', () => copy($('#resp-body').textContent, 'Body copied'));
  $('#bibles-load').addEventListener(
    'click',
    busy($('#bibles-load'), async () => {
      const t = await target('/v1/bibles');
      const res = await request('GET', t.url, t);
      addHistory(res);
      if (res.status === 200) populateBibleList(res);
      else showResponse(res);
    }),
  );
}

// =============================================================================
// Cache & keys (admin)
// =============================================================================

function renderStats(s) {
  const c = s.cache;
  const served = c.hits + c.coalesced + c.stale + c.misses;
  const rate = served ? `${(((c.hits + c.coalesced + c.stale) / served) * 100).toFixed(1)}%` : 'n/a';
  const rows = [
    ['backend', c.backend],
    ['memory entries', c.memoryEntries],
    ['hit rate', `${rate} (no upstream call)`],
    ['hits / coalesced / stale', `${c.hits} / ${c.coalesced} / ${c.stale}`],
    ['misses', c.misses],
    ['API.Bible calls', s.upstream.requests],
    ['upstream errors', c.upstreamErrors],
    ['user throttled', c.userThrottled],
    ...s.upstream.keys.map((k) => [
      `key #${k.index}`,
      `${k.key} ${k.available ? 'available' : `BENCHED ${k.benchedForSeconds}s`}${k.lastError ? ` (last: ${k.lastError})` : ''}`,
    ]),
  ];
  $('#stats-summary').replaceChildren(el('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
  $('#stats-raw').textContent = JSON.stringify(s, null, 2);
}

async function loadStats() {
  const r = await adminRequest('GET', '/admin/stats');
  if (r.status !== 200) {
    $('#stats-summary').replaceChildren(el('span', { class: 'err' }, `${r.status}: ${safeMessage(r)}`));
    return;
  }
  renderStats(JSON.parse(r.text));
}

async function purge(body, description) {
  if (!confirm(`Purge ${description} from the cache?\n\nThe next requests will cost API.Bible calls.`)) return;
  const r = await adminRequest('POST', '/admin/cache/purge', body);
  addHistory(r);
  $('#purge-result').textContent = `${r.status} ${r.statusText}\n${r.text}`;
}

function initCachePanel() {
  $('#stats-load').addEventListener('click', busy($('#stats-load'), loadStats));
  let timer;
  $('#stats-auto').addEventListener('change', (e) => {
    clearInterval(timer);
    if (e.target.checked) {
      loadStats();
      timer = setInterval(() => !$('#console').classList.contains('hidden') && loadStats(), 5000);
    }
  });
  $('#purge-go').addEventListener(
    'click',
    busy($('#purge-go'), async () => {
      const bibleId = $('#purge-bible').value.trim();
      const audioBibleId = $('#purge-audio').value.trim();
      if (!bibleId && !audioBibleId) throw new Error('Enter a Bible ID and/or Audio Bible ID');
      const body = { ...(bibleId && { bibleId }), ...(audioBibleId && { audioBibleId }) };
      await purge(body, [bibleId, audioBibleId].filter(Boolean).join(' + '));
    }),
  );
  $('#purge-all').addEventListener('click', busy($('#purge-all'), () => purge({ all: true }, 'EVERYTHING')));
}

// =============================================================================
// Health (public endpoints)
// =============================================================================

async function checkHealth() {
  for (const [id, path] of [['#health-live', '/healthz'], ['#health-ready', '/readyz']]) {
    const pill = $(id);
    try {
      const res = await fetch(path, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      pill.className = `pill ${res.ok ? 'ok' : 'err'}`;
      pill.textContent = `${path.slice(1)} ${res.ok ? 'ok' : res.status}`;
      pill.title = `GET ${path} → ${res.status} ${JSON.stringify(body)}`;
    } catch (e) {
      pill.className = 'pill err';
      pill.textContent = `${path.slice(1)} down`;
      pill.title = String(e);
    }
  }
}

// =============================================================================

await initLogin();
initSessionPanel();
initCachePanel();
checkHealth();
setInterval(checkHealth, 10_000);
if (session.idToken) await enterConsole();
else showLogin();
