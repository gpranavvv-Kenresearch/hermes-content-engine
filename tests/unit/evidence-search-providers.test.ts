import { describe, expect, it, vi } from 'vitest';
import type { SearchProvider, SearchQuery } from '../../src/contracts.js';
import { sourcePolicy } from '../../src/config/source-policy.config.js';
import {
  allowlistedSearch,
  ExaSearchProvider,
  KeyPool,
  loadKeysFromEnv,
  TavilySearchProvider,
  type ExaLike,
  type TavilyLike,
} from '../../src/evidence/search-providers.js';

const statusErr = (status: number, message = `Request failed with status code ${status}`) =>
  Object.assign(new Error(message), { response: { status } });

function tavilyFactory(behaviour: Record<string, () => unknown>) {
  const used: string[] = [];
  const factory = (key: string): TavilyLike => ({
    search: async (q, opts) => {
      used.push(key);
      const r = behaviour[key]!();
      if (r instanceof Error) throw r;
      void q; void opts;
      return r as Awaited<ReturnType<TavilyLike['search']>>;
    },
  });
  return { factory, used };
}
const okTavily = { results: [{ title: 'T', url: 'https://www.kenresearch.com/a', content: 'snip', publishedDate: '2026-01-01' }] };

describe('loadKeysFromEnv', () => {
  it('reads numbered keys, tolerates gaps, trims and de-duplicates', () => {
    const env = { TAVILY_API_KEY_1: ' a ', TAVILY_API_KEY_2: '', TAVILY_API_KEY_4: 'b', TAVILY_API_KEY_5: 'a', TAVILY_API_KEY: 'z' };
    expect(loadKeysFromEnv('TAVILY_API_KEY', env)).toEqual(['z', 'a', 'b']);
    expect(loadKeysFromEnv('EXA_API_KEY', env)).toEqual([]);
  });
});

describe('KeyPool', () => {
  it('rotates round-robin and honors cooldowns', () => {
    let t = 0;
    const p = new KeyPool(['a', 'b', 'c'], () => t);
    expect([p.next(), p.next(), p.next(), p.next()]).toEqual(['a', 'b', 'c', 'a']);
    p.retire('b', 1000);
    expect([p.next(), p.next(), p.next()]).toEqual(['c', 'a', 'c']);
    t = 2000;
    expect(new Set([p.next(), p.next(), p.next()])).toEqual(new Set(['a', 'b', 'c']));
  });

  it('returns undefined when all keys are retired', () => {
    const p = new KeyPool(['a']);
    p.retire('a', Infinity);
    expect(p.next()).toBeUndefined();
  });
});

describe('TavilySearchProvider', () => {
  it('maps results and passes options', async () => {
    const search = vi.fn(async () => okTavily);
    const p = new TavilySearchProvider({ keys: ['k1'], clientFactory: () => ({ search }) });
    const hits = await p.search({ query: 'widgets', maxResults: 3, includeDomains: ['kenresearch.com'] });
    expect(hits).toEqual([{ title: 'T', url: 'https://www.kenresearch.com/a', snippet: 'snip', publishedAt: '2026-01-01' }]);
    expect(search).toHaveBeenCalledWith('widgets', expect.objectContaining({ maxResults: 3, includeDomains: ['kenresearch.com'] }));
  });

  it('round-robins across keys on success', async () => {
    const { factory, used } = tavilyFactory({ a: () => okTavily, b: () => okTavily });
    const p = new TavilySearchProvider({ keys: ['a', 'b'], clientFactory: factory });
    await p.search({ query: 'x' });
    await p.search({ query: 'x' });
    await p.search({ query: 'x' });
    expect(used).toEqual(['a', 'b', 'a']);
  });

  it.each([401, 402, 429, 432])('rotates to the next key on status %i', async (status) => {
    const { factory, used } = tavilyFactory({ a: () => statusErr(status), b: () => okTavily });
    const p = new TavilySearchProvider({ keys: ['a', 'b'], clientFactory: factory });
    expect(await p.search({ query: 'x' })).toHaveLength(1);
    expect(used).toEqual(['a', 'b']);
  });

  it('rotates on quota-style messages without a status', async () => {
    const { factory } = tavilyFactory({ a: () => new Error("This request exceeds your plan's set usage limit."), b: () => okTavily });
    const p = new TavilySearchProvider({ keys: ['a', 'b'], clientFactory: factory });
    expect(await p.search({ query: 'x' })).toHaveLength(1);
  });

  it('stops with rate_limited once every key is exhausted, and does not retry permanently dead keys', async () => {
    const { factory, used } = tavilyFactory({ a: () => statusErr(432), b: () => statusErr(402) });
    const p = new TavilySearchProvider({ keys: ['a', 'b'], clientFactory: factory });
    await expect(p.search({ query: 'x' })).rejects.toMatchObject({ category: 'rate_limited', code: 'SEARCH_KEYS_EXHAUSTED' });
    expect(used).toEqual(['a', 'b']);
    await expect(p.search({ query: 'x' })).rejects.toMatchObject({ code: 'SEARCH_KEYS_EXHAUSTED' });
    expect(used).toEqual(['a', 'b']);
  });

  it('a 429 key comes back after its cooldown', async () => {
    let t = 0;
    let fail = true;
    const { factory, used } = tavilyFactory({ a: () => (fail ? statusErr(429) : okTavily) });
    const p = new TavilySearchProvider({ keys: ['a'], clientFactory: factory, now: () => t, cooldownMs: 1000 });
    await expect(p.search({ query: 'x' })).rejects.toMatchObject({ code: 'SEARCH_KEYS_EXHAUSTED' });
    fail = false;
    await expect(p.search({ query: 'x' })).rejects.toMatchObject({ code: 'SEARCH_KEYS_EXHAUSTED' });
    t = 1500;
    expect(await p.search({ query: 'x' })).toHaveLength(1);
    expect(used).toEqual(['a', 'a']);
  });

  it('does not rotate on non-quota errors and reports them retryable', async () => {
    const { factory, used } = tavilyFactory({ a: () => statusErr(500), b: () => okTavily });
    const p = new TavilySearchProvider({ keys: ['a', 'b'], clientFactory: factory });
    await expect(p.search({ query: 'x' })).rejects.toMatchObject({ category: 'retryable', code: 'SEARCH_FAILED' });
    expect(used).toEqual(['a']);
  });

  it('fails fatally without keys', async () => {
    const p = new TavilySearchProvider({ env: {}, clientFactory: () => ({ search: async () => okTavily }) });
    await expect(p.search({ query: 'x' })).rejects.toMatchObject({ category: 'fatal', code: 'SEARCH_NO_KEYS' });
  });

  it('loads keys from env by default', async () => {
    const search = vi.fn(async () => okTavily);
    const p = new TavilySearchProvider({ env: { TAVILY_API_KEY_1: 'envkey' }, clientFactory: (k) => { expect(k).toBe('envkey'); return { search }; } });
    await p.search({ query: 'x' });
    expect(search).toHaveBeenCalled();
  });

  it('times out slow calls', async () => {
    const p = new TavilySearchProvider({ keys: ['a'], timeoutMs: 20, clientFactory: () => ({ search: () => new Promise(() => undefined) }) });
    await expect(p.search({ query: 'x' })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('ExaSearchProvider', () => {
  const exaOk = {
    results: [
      { title: null, url: 'https://www.kenresearch.com/a', highlights: ['one', 'two'], publishedDate: '2026-02-02' },
      { title: 'B', url: 'https://example.org/b', text: 'x'.repeat(900) },
    ],
  };

  it('maps highlights/text and null titles', async () => {
    const search = vi.fn(async () => exaOk);
    const p = new ExaSearchProvider({ keys: ['k'], clientFactory: (): ExaLike => ({ search }) });
    const hits = await p.search({ query: 'q', maxResults: 5, includeDomains: ['kenresearch.com'] });
    expect(hits[0]).toEqual({ title: '', url: 'https://www.kenresearch.com/a', snippet: 'one two', publishedAt: '2026-02-02' });
    expect(hits[1]!.snippet).toHaveLength(500);
    expect(search).toHaveBeenCalledWith('q', expect.objectContaining({ numResults: 5, includeDomains: ['kenresearch.com'] }));
  });

  it('rotates keys on 402 and exhausts with rate_limited', async () => {
    const calls: string[] = [];
    const p = new ExaSearchProvider({
      keys: ['a', 'b'],
      clientFactory: (k): ExaLike => ({ search: async () => { calls.push(k); throw statusErr(402); } }),
    });
    await expect(p.search({ query: 'q' })).rejects.toMatchObject({ category: 'rate_limited' });
    expect(calls).toEqual(['a', 'b']);
  });
});

describe('allowlistedSearch', () => {
  function fake(urls: string[]) {
    const queries: SearchQuery[] = [];
    const provider: SearchProvider = {
      id: 'fake',
      search: async (q) => {
        queries.push(q);
        return urls.map((url, i) => ({ title: `t${i}`, url, snippet: '' }));
      },
    };
    return { provider, queries };
  }

  it('adds includeDomains for fact/citation and ignores provider promises by re-validating', async () => {
    const { provider, queries } = fake([
      'https://www.kenresearch.com/report/a',
      'https://www.imarcgroup.com/x',
      'https://evil.com/kenresearch.com',
      'https://kenresearch.com.evil.com/a',
      'https://stats.example.gov/data',
      'https://www.kenresearch.com/report/a',
    ]);
    for (const purpose of ['fact', 'citation'] as const) {
      const r = await allowlistedSearch({ provider, query: 'widgets', purpose, policy: sourcePolicy, maxResults: 10 });
      expect(r.hits.map((h) => h.url)).toEqual(['https://www.kenresearch.com/report/a', 'https://stats.example.gov/data']);
      expect(r.discarded).toBe(3);
      expect(r.discardedHits.map((d) => d.sourceType)).toContain('competitor_blocked');
    }
    expect(queries[0]!.includeDomains).toEqual(expect.arrayContaining(['kenresearch.com', 'europa.eu']));
  });

  it('planning: no includeDomains, other hosts kept, competitors still dropped', async () => {
    const { provider, queries } = fake(['https://example.org/trend', 'https://technavio.com/x', 'https://sub.imarcgroup.com/y']);
    const r = await allowlistedSearch({ provider, query: 'q', purpose: 'planning', policy: sourcePolicy });
    expect(queries[0]!.includeDomains).toBeUndefined();
    expect(r.hits.map((h) => h.url)).toEqual(['https://example.org/trend']);
    expect(r.discarded).toBe(2);
  });

  it('caps results to maxResults and over-fetches from the provider', async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://www.kenresearch.com/r/${i}`);
    const { provider, queries } = fake(urls);
    const r = await allowlistedSearch({ provider, query: 'q', purpose: 'fact', policy: sourcePolicy, maxResults: 3 });
    expect(r.hits).toHaveLength(3);
    expect(queries[0]!.maxResults).toBe(6);
  });

  it('passes extra include domains and the abort signal', async () => {
    const { provider, queries } = fake([]);
    const ac = new AbortController();
    await allowlistedSearch({ provider, query: 'q', purpose: 'fact', policy: sourcePolicy, extraIncludeDomains: ['gov.in'], signal: ac.signal });
    expect(queries[0]!.includeDomains).toContain('gov.in');
    expect(queries[0]!.signal).toBe(ac.signal);
  });

  it('discards malformed urls instead of throwing', async () => {
    const { provider } = fake(['not a url', 'javascript:alert(1)', 'https://www.kenresearch.com/ok']);
    const r = await allowlistedSearch({ provider, query: 'q', purpose: 'fact', policy: sourcePolicy });
    expect(r.hits).toHaveLength(1);
    expect(r.discarded).toBe(2);
  });
});
