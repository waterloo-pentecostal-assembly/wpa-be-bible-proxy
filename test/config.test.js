import { describe, expect, it } from 'vitest';
import { loadConfig, MAX_CONTENT_AGE_SECONDS } from '../src/config/config.js';

describe('config', () => {
  it('requires at least one API key', () => {
    expect(() => loadConfig({})).toThrow(/API_BIBLE_KEYS/);
    expect(() => loadConfig({ API_BIBLE_KEYS: ' , ' })).toThrow(/API_BIBLE_KEYS/);
  });

  it('clamps cache TTLs to the API.Bible 30-day limit', () => {
    const c = loadConfig({ API_BIBLE_KEYS: 'k', CACHE_TTL_CONTENT_SECONDS: String(365 * 86400) });
    expect(c.cache.ttlSeconds.content).toBe(MAX_CONTENT_AGE_SECONDS);
    expect(MAX_CONTENT_AGE_SECONDS).toBeLessThan(30 * 86400);
  });

  it('accepts one or several Firebase projects', () => {
    expect(loadConfig({ API_BIBLE_KEYS: 'k' }).firebase.projectIds).toEqual([]);
    expect(loadConfig({ API_BIBLE_KEYS: 'k', FIREBASE_PROJECT_ID: 'p' }).firebase.projectIds).toEqual(['p']);
    expect(
      loadConfig({ API_BIBLE_KEYS: 'k', FIREBASE_PROJECT_ID: 'a', FIREBASE_PROJECT_IDS: 'a, b' }).firebase.projectIds,
    ).toEqual(['a', 'b']);
  });
});
