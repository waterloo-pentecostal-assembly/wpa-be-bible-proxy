import { DEFAULT_RATE_LIMIT_COOLDOWN_MS, INVALID_KEY_COOLDOWN_MS } from './keyPool.js';

export class ApiBibleClient {
  fetchImpl;
  /** Total requests sent to API.Bible (each one counts against the quota). */
  requestCount = 0;

  opts;

  constructor(opts) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** @param pathAndQuery e.g. `/bibles/abc/verses/GEN.1.1?content-type=text` (already encoded) */
  async get(pathAndQuery) {
    const { keys, log } = this.opts;
    const url = this.opts.baseUrl + pathAndQuery;
    const candidates = keys.available();
    let forbidden;

    for (const [attempt, key] of candidates.entries()) {
      let res;
      let body;
      try {
        this.requestCount++;
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { 'api-key': key, accept: 'application/json' },
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        body = await res.text();
      } catch (err) {
        log.warn({ err: errMessage(err), path: pathAndQuery }, 'API.Bible request failed');
        return { type: 'unavailable', reason: 'upstream_unreachable' };
      }

      switch (res.status) {
        case 200: {
          try {
            return { type: 'ok', status: 200, body, json: JSON.parse(body) };
          } catch {
            log.error({ path: pathAndQuery }, 'API.Bible returned non-JSON 200 response');
            return { type: 'unavailable', reason: 'upstream_invalid_response' };
          }
        }
        case 400:
        case 404:
          return { type: 'negative', status: res.status, body };
        case 401:
          log.error({ keyIndex: attempt }, 'API.Bible rejected API key (401); benching key');
          keys.bench(key, INVALID_KEY_COOLDOWN_MS, '401 Unauthorized');
          continue;
        case 403:
          // "Not authorized to retrieve the specified Bible": another key/plan may be licensed.
          forbidden = { body };
          continue;
        case 429: {
          const cooldown = parseRetryAfter(res.headers.get('retry-after')) ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
          log.warn({ keyIndex: attempt, cooldownMs: cooldown }, 'API.Bible rate limit hit; benching key');
          keys.bench(key, cooldown, '429 Too Many Requests');
          continue;
        }
        default:
          log.warn({ status: res.status, path: pathAndQuery }, 'API.Bible returned unexpected status');
          return { type: 'unavailable', reason: `upstream_status_${res.status}` };
      }
    }

    if (forbidden) return { type: 'negative', status: 403, body: forbidden.body };
    return {
      type: 'unavailable',
      reason: 'no_api_key_available',
      retryAfterSec: Math.max(1, Math.ceil(keys.msUntilNextAvailable() / 1000)),
    };
  }
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function errMessage(err) {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
