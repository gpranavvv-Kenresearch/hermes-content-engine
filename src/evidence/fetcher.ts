import type { Fetcher, FetchResult } from '../contracts.js';
import { EngineError } from '../errors.js';
import { timeoutPolicy, withTimeout } from '../safety/timeouts.js';
import type { SourcePolicy, SourcePurpose } from '../schemas/index.js';
import { classifyUrl } from './source-validator.js';

export const MAX_REDIRECTS = 5;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const USER_AGENT = 'KenResearchContentEngine/0.1 (+https://www.kenresearch.com; research-content-bot)';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface SafeFetcherOptions {
  fetchImpl?: FetchImpl;
  policy: SourcePolicy;
  purpose: SourcePurpose;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
}

/** A URL (requested, redirect hop) failed the source policy. Never retried. */
export class SourceBlockedError extends EngineError {
  constructor(url: string, reason: string, sourceType: string) {
    super(`Source blocked: ${url} (${reason})`, 'fatal', 'SOURCE_BLOCKED', { detail: { url, reason, sourceType } });
  }
}

export class FetchProtocolError extends EngineError {
  constructor(
    message: string,
    code: string,
    category: 'fatal' | 'retryable' | 'rate_limited',
    detail?: Record<string, unknown>,
  ) {
    super(message, category, code, detail ? { detail } : {});
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function assertAllowed(url: string, purpose: SourcePurpose, policy: SourcePolicy): void {
  const c = classifyUrl(url, purpose, policy);
  if (!c.allowed) throw new SourceBlockedError(url, c.reason, c.sourceType);
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

async function readBodyCapped(res: Response, maxBytes: number, url: string): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new FetchProtocolError(`Body too large (${declared} bytes) for ${url}`, 'BODY_TOO_LARGE', 'fatal', { url, declared });
  }
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FetchProtocolError(`Body exceeds ${maxBytes} bytes for ${url}`, 'BODY_TOO_LARGE', 'fatal', { url });
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/**
 * Policy-enforcing fetcher. Redirects are followed manually; every hop is
 * validated BEFORE it is requested, so a blocked or non-allowed host is never
 * contacted. The canonical URL is not known here: callers validate it with
 * validateFetchedSource after extraction.
 */
export function createSafeFetcher(options: SafeFetcherOptions): Fetcher {
  const impl: FetchImpl = options.fetchImpl ?? ((u, init) => fetch(u, init));
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const maxBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const timeoutMs = options.timeoutMs ?? timeoutPolicy.httpRequest;

  return async (url, fetchOptions = {}): Promise<FetchResult> => {
    return withTimeout(`fetch ${url}`, timeoutMs, async (timeoutSignal) => {
      const signal = fetchOptions.signal ? AbortSignal.any([timeoutSignal, fetchOptions.signal]) : timeoutSignal;
      let current = url;

      for (let hop = 0; hop <= maxRedirects; hop++) {
        assertAllowed(current, options.purpose, options.policy);

        let res: Response;
        try {
          res = await impl(current, {
            method: 'GET',
            redirect: 'manual',
            signal,
            headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9' },
          });
        } catch (e) {
          if (e instanceof EngineError) throw e;
          throw new FetchProtocolError(
            `Network error fetching ${current}: ${(e as Error).message}`,
            'FETCH_NETWORK_ERROR',
            'retryable',
            { url: current },
          );
        }

        if (REDIRECT_STATUSES.has(res.status)) {
          await discard(res);
          const location = res.headers.get('location');
          if (!location) throw new FetchProtocolError(`Redirect without Location from ${current}`, 'BAD_REDIRECT', 'fatal', { url: current });
          try {
            current = new URL(location, current).toString();
          } catch {
            throw new FetchProtocolError(`Invalid redirect target from ${current}`, 'BAD_REDIRECT', 'fatal', { url: current });
          }
          continue;
        }

        if (res.status === 429) {
          await discard(res);
          const ra = Number(res.headers.get('retry-after'));
          throw new EngineError(`HTTP 429 from ${current}`, 'rate_limited', 'HTTP_429', {
            ...(Number.isFinite(ra) && ra > 0 ? { retryAfterMs: ra * 1000 } : {}),
            detail: { url: current },
          });
        }
        if (res.status >= 500) {
          await discard(res);
          throw new FetchProtocolError(`HTTP ${res.status} from ${current}`, 'HTTP_5XX', 'retryable', { url: current, status: res.status });
        }
        if (res.status < 200 || res.status >= 300) {
          await discard(res);
          throw new FetchProtocolError(`HTTP ${res.status} from ${current}`, 'HTTP_ERROR', 'fatal', { url: current, status: res.status });
        }

        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        if (!/^(text\/html|application\/xhtml\+xml)\b/.test(contentType)) {
          await discard(res);
          throw new FetchProtocolError(
            `Unsupported content-type "${contentType}" from ${current}`,
            'UNSUPPORTED_CONTENT_TYPE',
            'fatal',
            { url: current, contentType },
          );
        }

        const html = await readBodyCapped(res, maxBytes, current);
        return { requestedUrl: url, finalUrl: current, status: res.status, html };
      }

      throw new FetchProtocolError(`Too many redirects (>${maxRedirects}) starting at ${url}`, 'TOO_MANY_REDIRECTS', 'fatal', { url });
    });
  };
}
