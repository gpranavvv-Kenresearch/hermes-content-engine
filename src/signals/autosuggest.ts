import type { Collected, SuggestRecord } from './types.js';

/** Query modifiers from the PRD (cost, market, investment, ...). Editorial expansions, not Google output. */
export const MODIFIERS = ['cost', 'market', 'investment', 'infrastructure', 'challenges', 'future', 'operators', 'regulation', 'vs', 'how', 'why'] as const;

export function classifyIntent(query: string): string {
  const q = query.toLowerCase();
  if (/\b(price|cost|cheap|buy|for sale|quote)\b/.test(q)) return 'commercial';
  if (/\b(how|why|what|which|can|does)\b/.test(q)) return 'question';
  if (/\b(vs|versus|compare|best|top)\b/.test(q)) return 'comparison';
  if (/\b(market|report|size|share|forecast|outlook|statistics|growth)\b/.test(q)) return 'research';
  if (/\b(manufacturers?|companies|suppliers?|operators?|brands?)\b/.test(q)) return 'company';
  return 'general';
}

/** One Autosuggest request. Predictions are exactly what Google returned. Network failure is DATA_UNAVAILABLE, not an empty list. */
export async function suggest(seed: string, opts: { country?: string; language?: string; fetchImpl?: typeof fetch } = {}): Promise<Collected<SuggestRecord>> {
  const language = opts.language ?? 'en';
  const country = opts.country ?? null;
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(seed)}&hl=${language}${country ? `&gl=${country.toLowerCase()}` : ''}`;
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { status: res.status === 429 ? 'THROTTLED' : 'DATA_UNAVAILABLE', items: [], note: `HTTP ${res.status}` };
    const json = (await res.json()) as [string, string[]];
    const predictions = Array.isArray(json[1]) ? json[1] : [];
    const collectedAt = new Date().toISOString();
    const items = predictions.map((p): SuggestRecord => ({
      seedQuery: seed,
      returnedPrediction: p,
      intentClass: classifyIntent(p),
      verifiedPrediction: true,
      provenance: { source: 'google-autosuggest', method: url, collectedAt, country, language },
    }));
    return { status: items.length ? 'OK' : 'EMPTY', items };
  } catch (e) {
    return { status: 'DATA_UNAVAILABLE', items: [], note: (e as Error).message };
  }
}

/** Seed plus modifiers; duplicates across seeds are merged (first occurrence wins). */
export async function suggestExpanded(seed: string, opts: { country?: string; language?: string; modifiers?: readonly string[]; delayMs?: number } = {}): Promise<Collected<SuggestRecord>> {
  const seen = new Map<string, SuggestRecord>();
  let failures = 0;
  let requests = 0;
  for (const mod of ['', ...(opts.modifiers ?? MODIFIERS)]) {
    const q = mod ? `${seed} ${mod}` : seed;
    const r = await suggest(q, opts);
    requests++;
    if (r.status === 'THROTTLED' || r.status === 'DATA_UNAVAILABLE') failures++;
    for (const item of r.items) {
      const key = item.returnedPrediction.toLowerCase();
      if (!seen.has(key)) seen.set(key, item);
    }
    await new Promise((res) => setTimeout(res, opts.delayMs ?? 400));
  }
  const items = [...seen.values()];
  return { status: items.length ? 'OK' : failures ? 'DATA_UNAVAILABLE' : 'EMPTY', items, note: `${requests} requests, ${failures} failed` };
}
