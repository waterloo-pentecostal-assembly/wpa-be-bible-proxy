/**
 * Allowlist of API.Bible v1 GET endpoints exposed to clients.
 *
 * Client paths mirror API.Bible exactly (under /v1), so apps can switch from calling
 * API.Bible directly by changing only the base URL and auth header.
 *
 * Every route declares the query parameters it accepts. Unknown parameters are rejected:
 * otherwise a client could append `?x=<random>` to bypass the cache and drain the quota.
 */

const BIBLE_LIST_QUERY = ['language', 'abbreviation', 'name', 'ids', 'include-full-details'];
const BOOKS_QUERY = ['include-chapters', 'include-chapters-and-sections'];
const CONTENT_QUERY = [
  'content-type',
  'include-notes',
  'include-titles',
  'include-chapter-numbers',
  'include-verse-numbers',
  'include-verse-spans',
  'parallels',
];
const SEARCH_QUERY = ['query', 'limit', 'offset', 'sort', 'range', 'fuzziness'];

export const ROUTES = [
  // Text bibles
  { path: '/bibles', cacheClass: 'metadata', query: BIBLE_LIST_QUERY },
  { path: '/bibles/:bibleId', cacheClass: 'metadata', query: [] },
  { path: '/bibles/:bibleId/books', cacheClass: 'metadata', query: BOOKS_QUERY },
  { path: '/bibles/:bibleId/books/:bookId', cacheClass: 'metadata', query: ['include-chapters'] },
  { path: '/bibles/:bibleId/books/:bookId/chapters', cacheClass: 'metadata', query: [] },
  { path: '/bibles/:bibleId/books/:bookId/sections', cacheClass: 'metadata', query: [] },
  { path: '/bibles/:bibleId/chapters/:chapterId', cacheClass: 'content', query: CONTENT_QUERY },
  { path: '/bibles/:bibleId/chapters/:chapterId/sections', cacheClass: 'metadata', query: [] },
  { path: '/bibles/:bibleId/chapters/:chapterId/verses', cacheClass: 'metadata', query: [] },
  { path: '/bibles/:bibleId/passages/:passageId', cacheClass: 'content', query: [...CONTENT_QUERY, 'use-org-id'] },
  { path: '/bibles/:bibleId/sections/:sectionId', cacheClass: 'content', query: CONTENT_QUERY },
  { path: '/bibles/:bibleId/verses/:verseId', cacheClass: 'content', query: [...CONTENT_QUERY, 'use-org-id'] },
  { path: '/bibles/:bibleId/search', cacheClass: 'search', query: SEARCH_QUERY },

  // Audio bibles. Chapter responses carry signed resource URLs; their TTL is additionally
  // capped by the `expiresAt` field in the body (see proxy.js).
  { path: '/audio-bibles', cacheClass: 'metadata', query: [...BIBLE_LIST_QUERY, 'bibleId'] },
  { path: '/audio-bibles/:audioBibleId', cacheClass: 'metadata', query: [] },
  { path: '/audio-bibles/:audioBibleId/books', cacheClass: 'metadata', query: ['include-chapters'] },
  { path: '/audio-bibles/:audioBibleId/books/:bookId', cacheClass: 'metadata', query: ['include-chapters'] },
  { path: '/audio-bibles/:audioBibleId/books/:bookId/chapters', cacheClass: 'metadata', query: [] },
  { path: '/audio-bibles/:audioBibleId/chapters/:chapterId', cacheClass: 'content', query: [] },
];

/**
 * Path identifiers in API.Bible look like `de4e12af7f28f599-02`, `GEN`, `GEN.1`,
 * `GEN.1.1-GEN.1.5`. Restrict to that alphabet so nothing like `..` or `/` reaches upstream.
 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._,:-]{0,127}$/;

export const MAX_QUERY_VALUE_LENGTH = 256;

export class RequestValidationError extends Error {}

/** Build the upstream path from a route template and validated params. */
export function buildUpstreamPath(route, params) {
  return route.path.replace(/:([A-Za-z]+)/g, (_, name) => {
    const value = params[name];
    if (value === undefined || !ID_PATTERN.test(value)) {
      throw new RequestValidationError(`Invalid path parameter "${name}"`);
    }
    return encodeURIComponent(value);
  });
}

/**
 * Validate and canonicalise the query string so equivalent requests share a cache key:
 * keys sorted, single-valued, whitespace in `query` (search) collapsed.
 */
export function normalizeQuery(route, raw) {
  const allowed = new Set(route.query);
  const pairs = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) throw new RequestValidationError(`Unsupported query parameter "${key}"`);
    if (typeof value !== 'string') throw new RequestValidationError(`Query parameter "${key}" must be given once`);
    let v = value.trim();
    if (key === 'query') v = v.replace(/\s+/g, ' ');
    if (v.length > MAX_QUERY_VALUE_LENGTH) throw new RequestValidationError(`Query parameter "${key}" is too long`);
    if (v === '') continue;
    pairs.push([key, v]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new URLSearchParams(pairs).toString();
}
