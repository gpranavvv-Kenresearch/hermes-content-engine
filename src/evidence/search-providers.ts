import type { SearchHit, SearchProvider, SearchQuery } from '../contracts.js';
import { EngineError } from '../errors.js';
import { timeoutPolicy, withTimeout } from '../safety/timeouts.js';
import type { SourcePolicy, SourcePurpose } from '../schemas/index.js';
import { classifyUrl } from './source-validator.js';

// ------------------------------------------------------------------ key pool

/** Reads PREFIX_1..PREFIX_N (N up to 50, gaps allowed) plus an unnumbered PREFIX, trimmed, de-duplicated. */
export function loadKeysFromEnv(prefix: string, env: Record<string, string | undefined> = process.env): string[] {
  const keys: string[] = [];
  const single = env[prefix]?.trim();
  if (single) keys.push(single);
  for (let i = 1; i <= 50; i++) {
    const k = env[`${prefix}_${i}`]?.trim();
    if (k) keys.push(k);
  }
  return [...new Set(keys)];
}

type KeyState = { until: number }; // Infinity = permanently unusable in this process

/** Round-robin key pool with per-key cooldowns. */
export class KeyPool {
  private readonly keys: string[];
  private readonly state = new Map<string, KeyState>();
  private cursor = 0;

  constructor(
    keys: readonly string[],
    private readonly now: () => number = Date.now,
  ) {
    this.keys = [...new Set(keys)];
  }

  get size(): number {
    return this.keys.length;
  }

  /** Next usable key in round-robin order, or undefined when every key is cooling down / exhausted. */
  next(): string | undefined {
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.cursor + i) % this.keys.length;
      const key = this.keys[idx]!;
      if ((this.state.get(key)?.until ?? 0) <= this.now()) {
        this.cursor = (idx + 1) % this.keys.length;
        return key;
      }
    }
    return undefined;
  }

  /** Takes a key out of rotation for `ms` (Infinity for the rest of the process). */
  retire(key: string, ms: number): void {
    this.state.set(key, { until: ms === Infinity ? Infinity : this.now() + ms });
  }
}

// ---------------------------------------------------------- error handling

/** Statuses meaning "this key cannot serve the request": auth, payment, rate/plan limits (Tavily uses 432/433). */
const QUOTA_STATUSES = new Set([401, 402, 403, 429, 432, 433]);
const PERMANENT_STATUSES = new Set([401, 402, 403, 432, 433]);
const QUOTA_MESSAGE_RE =
  /(usage limit|plan'?s set|quota|rate limit|too many requests|excessive requests|insufficient credits|payment required|unauthorized|invalid api key|missing or invalid)/i;

export function errorStatus(e: unknown): number | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const o = e as Record<string, unknown>;
  const resp = o.response as Record<string, unknown> | undefined;
  for (const c of [o.statusCode, o.status, resp?.status]) if (typeof c === 'number') return c;
  const msg = typeof o.message === 'string' ? o.message : '';
  const m = /\b(?:status(?: code)?|HTTP)\s*:?\s*(\d{3})\b/i.exec(msg) ?? /\b(401|402|429|432|433)\b/.exec(msg);
  return m ? Number(m[1]) : undefined;
}

export function isQuotaError(e: unknown): boolean {
  const s = errorStatus(e);
  if (s !== undefined && QUOTA_STATUSES.has(s)) return true;
  return s === undefined && QUOTA_MESSAGE_RE.test(e instanceof Error ? e.message : '');
}

function isPermanent(e: unknown): boolean {
  const s = errorStatus(e);
  return s !== undefined && PERMANENT_STATUSES.has(s);
}

// ------------------------------------------------------------ shared driver

interface DriverOptions<C> {
  id: string;
  keys: readonly string[];
  clientFactory: (apiKey: string) => C | Promise<C>;
  cooldownMs: number;
  now?: () => number;
  timeoutMs: number;
}

class RotatingClientDriver<C> {
  private readonly pool: KeyPool;
  private readonly clients = new Map<string, C>();

  constructor(private readonly o: DriverOptions<C>) {
    this.pool = new KeyPool(o.keys, o.now);
  }

  async run<T>(label: string, signal: AbortSignal | undefined, call: (client: C) => Promise<T>): Promise<T> {
    if (this.pool.size === 0) {
      throw new EngineError(`${this.o.id}: no API keys configured`, 'fatal', 'SEARCH_NO_KEYS');
    }
    let lastQuota: unknown;
    for (let attempt = 0; attempt < this.pool.size; attempt++) {
      if (signal?.aborted) throw new EngineError(`${this.o.id}: search aborted`, 'retryable', 'SEARCH_ABORTED');
      const key = this.pool.next();
      if (!key) break;
      try {
        let client = this.clients.get(key);
        if (!client) {
          client = await this.o.clientFactory(key);
          this.clients.set(key, client);
        }
        const c = client;
        return await withTimeout(`${this.o.id} ${label}`, this.o.timeoutMs, () => call(c));
      } catch (e) {
        if (e instanceof EngineError) throw e;
        if (isQuotaError(e)) {
          this.pool.retire(key, isPermanent(e) ? Infinity : this.o.cooldownMs);
          lastQuota = e;
          continue;
        }
        throw new EngineError(`${this.o.id}: search failed: ${(e as Error)?.message ?? String(e)}`, 'retryable', 'SEARCH_FAILED', { cause: e });
      }
    }
    throw new EngineError(`${this.o.id}: all API keys exhausted or rate limited`, 'rate_limited', 'SEARCH_KEYS_EXHAUSTED', {
      cause: lastQuota,
      retryAfterMs: this.o.cooldownMs,
    });
  }
}

export interface ProviderOptions<C> {
  /** Defaults to the TAVILY_API_KEY_1..N / EXA_API_KEY_1..N environment variables. */
  keys?: readonly string[];
  env?: Record<string, string | undefined>;
  /** Inject a fake client in tests. The default lazily imports the real SDK. */
  clientFactory?: (apiKey: string) => C | Promise<C>;
  now?: () => number;
  timeoutMs?: number;
  /** How long a rate-limited (429) key sits out. Auth/payment/plan-limit failures retire the key for the process. */
  cooldownMs?: number;
}

// ------------------------------------------------------------------- Tavily

/** The subset of the @tavily/core client this module uses. */
export interface TavilyLike {
  search(
    query: string,
    options?: Record<string, unknown>,
  ): Promise<{ results: Array<{ title?: string; url: string; content?: string; publishedDate?: string }> }>;
}

export class TavilySearchProvider implements SearchProvider {
  readonly id = 'tavily';
  private readonly driver: RotatingClientDriver<TavilyLike>;

  constructor(options: ProviderOptions<TavilyLike> = {}) {
    this.driver = new RotatingClientDriver<TavilyLike>({
      id: 'tavily',
      keys: options.keys ?? loadKeysFromEnv('TAVILY_API_KEY', options.env),
      clientFactory:
        options.clientFactory ??
        (async (apiKey) => {
          const { tavily } = await import('@tavily/core');
          return tavily({ apiKey }) as unknown as TavilyLike;
        }),
      cooldownMs: options.cooldownMs ?? 60_000,
      timeoutMs: options.timeoutMs ?? timeoutPolicy.httpRequest,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const opts: Record<string, unknown> = {
      maxResults: query.maxResults ?? 10,
      searchDepth: 'basic',
      includeAnswer: false,
      includeRawContent: false,
    };
    if (query.includeDomains && query.includeDomains.length > 0) opts.includeDomains = query.includeDomains;
    const res = await this.driver.run('search', query.signal, (c) => c.search(query.query, opts));
    return (res.results ?? []).map((r) => {
      const hit: SearchHit = { title: r.title ?? '', url: r.url, snippet: r.content ?? '' };
      if (r.publishedDate) hit.publishedAt = r.publishedDate;
      return hit;
    });
  }
}

// ---------------------------------------------------------------------- Exa

/** The subset of the exa-js client this module uses. */
export interface ExaLike {
  search(
    query: string,
    options?: Record<string, unknown>,
  ): Promise<{
    results: Array<{ title?: string | null; url: string; publishedDate?: string; highlights?: string[]; text?: string; summary?: string }>;
  }>;
}

export class ExaSearchProvider implements SearchProvider {
  readonly id = 'exa';
  private readonly driver: RotatingClientDriver<ExaLike>;

  constructor(options: ProviderOptions<ExaLike> = {}) {
    this.driver = new RotatingClientDriver<ExaLike>({
      id: 'exa',
      keys: options.keys ?? loadKeysFromEnv('EXA_API_KEY', options.env),
      clientFactory:
        options.clientFactory ??
        (async (apiKey) => {
          const { Exa } = await import('exa-js');
          return new Exa(apiKey) as unknown as ExaLike;
        }),
      cooldownMs: options.cooldownMs ?? 60_000,
      timeoutMs: options.timeoutMs ?? timeoutPolicy.httpRequest,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const opts: Record<string, unknown> = {
      numResults: query.maxResults ?? 10,
      contents: { highlights: true },
    };
    if (query.includeDomains && query.includeDomains.length > 0) opts.includeDomains = query.includeDomains;
    const res = await this.driver.run('search', query.signal, (c) => c.search(query.query, opts));
    return (res.results ?? []).map((r) => {
      const snippet = r.highlights?.join(' ') || r.summary || r.text?.slice(0, 500) || '';
      const hit: SearchHit = { title: r.title ?? '', url: r.url, snippet };
      if (r.publishedDate) hit.publishedAt = r.publishedDate;
      return hit;
    });
  }
}

// ------------------------------------------------------ allowlisted search

export interface AllowlistedSearchOptions {
  provider: SearchProvider;
  query: string;
  purpose: SourcePurpose;
  policy: SourcePolicy;
  maxResults?: number;
  /** Extra provider-side domain hints (e.g. explicit government suffixes). Never a security boundary. */
  extraIncludeDomains?: string[];
  signal?: AbortSignal;
}

export interface DiscardedHit {
  url: string;
  reason: string;
  sourceType: string;
}

export interface AllowlistedSearchResult {
  hits: SearchHit[];
  discarded: number;
  discardedHits: DiscardedHit[];
}

/**
 * For fact/citation purposes asks the provider to restrict to Ken Research +
 * explicitly allowed hosts (government hosts are pattern-based and cannot be
 * enumerated, so callers may add suffix hints). Regardless of purpose, EVERY
 * returned URL is re-validated here; violations are discarded and counted.
 */
export async function allowlistedSearch(options: AllowlistedSearchOptions): Promise<AllowlistedSearchResult> {
  const max = options.maxResults ?? 10;
  const strict = options.purpose !== 'planning';
  const includeDomains = strict
    ? [...new Set([...options.policy.kenResearchHosts, ...options.policy.extraAllowedHosts, ...(options.extraIncludeDomains ?? [])])]
    : undefined;

  const query: SearchQuery = {
    query: options.query,
    // Over-fetch: post-filtering will drop violations.
    maxResults: Math.min(max * 2, 20),
    ...(includeDomains ? { includeDomains } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const raw = await options.provider.search(query);

  const hits: SearchHit[] = [];
  const discardedHits: DiscardedHit[] = [];
  const seen = new Set<string>();
  for (const hit of raw) {
    const c = classifyUrl(hit.url, options.purpose, options.policy);
    if (!c.allowed) {
      discardedHits.push({ url: hit.url, reason: c.reason, sourceType: c.sourceType });
      continue;
    }
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    if (hits.length < max) hits.push(hit);
  }
  return { hits, discarded: discardedHits.length, discardedHits };
}
