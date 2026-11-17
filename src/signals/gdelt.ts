import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { shortHash } from '../utils/hash.js';
import type { Collected, GdeltArticle } from './types.js';

const ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const MIN_GAP_MS = 6_000; // GDELT asks for one request per 5 seconds; start above that
let lastCall = 0;
let cooldownUntil = 0;

export interface GdeltOptions {
  timespan?: string; // e.g. 7d
  maxRecords?: number;
  cacheDir?: string;
  cacheHours?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Serialized: waits for the gap, honours cooldown after a throttle, caches repeated queries. Never turns a throttle into "no news". */
export async function gdeltArticles(query: string, opts: GdeltOptions = {}): Promise<Collected<GdeltArticle>> {
  let result = await gdeltOnce(query, opts);
  // A throttle is retried (cooldown is applied inside) a bounded number of times, then reported as THROTTLED, never as empty.
  for (let attempt = 0; attempt < 2 && result.status === 'THROTTLED'; attempt++) result = await gdeltOnce(query, opts);
  return result;
}

async function gdeltOnce(query: string, opts: GdeltOptions): Promise<Collected<GdeltArticle>> {
  const timespan = opts.timespan ?? '7d';
  const params = new URLSearchParams({ query, mode: 'artlist', format: 'json', maxrecords: String(opts.maxRecords ?? 50), timespan, sort: 'datedesc' });
  const url = `${ENDPOINT}?${params}`;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cacheDir = opts.cacheDir ?? path.resolve('.cache/signals/gdelt');
  const cacheFile = path.join(cacheDir, `${shortHash(url, 20)}.json`);
  const maxAgeMs = (opts.cacheHours ?? 6) * 3_600_000;
  try {
    if (existsSync(cacheFile)) {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as { at: number; result: Collected<GdeltArticle> };
      if (Date.now() - cached.at < maxAgeMs && cached.result.status !== 'THROTTLED' && cached.result.status !== 'DATA_UNAVAILABLE') return cached.result;
    }
  } catch { /* unreadable cache: fetch fresh */ }

  const wait = Math.max(lastCall + MIN_GAP_MS - Date.now(), cooldownUntil - Date.now(), 0);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const f = opts.fetchImpl ?? fetch;
  let result: Collected<GdeltArticle>;
  try {
    const res = await f(url, { signal: AbortSignal.timeout(45_000) });
    const text = await res.text();
    if (res.status === 429 || /please limit requests/i.test(text)) {
      cooldownUntil = Date.now() + 60_000; // adaptive: longer pause after a throttle
      return { status: 'THROTTLED', items: [], note: 'GDELT asked to slow down; cooling down 60s' };
    }
    if (!res.ok) return { status: 'DATA_UNAVAILABLE', items: [], note: `HTTP ${res.status}` };
    const trimmed = text.trim();
    if (trimmed === '' || trimmed === '{}') {
      result = { status: 'EMPTY', items: [] };
    } else {
      let json: { articles?: Array<Record<string, string>> };
      try { json = JSON.parse(trimmed); } catch { return { status: 'DATA_UNAVAILABLE', items: [], note: `non-JSON reply: ${trimmed.slice(0, 80)}` }; }
      const collectedAt = new Date().toISOString();
      const items = (json.articles ?? []).map((a): GdeltArticle => ({
        title: a.title ?? '',
        url: a.url ?? '',
        domain: a.domain ?? '',
        language: a.language ?? null,
        sourceCountry: a.sourcecountry ?? null,
        seenAt: a.seendate ?? null,
        provenance: { source: 'gdelt-doc', method: url, collectedAt, country: null, language: null },
      }));
      result = { status: items.length ? 'OK' : 'EMPTY', items };
    }
  } catch (e) {
    return { status: 'DATA_UNAVAILABLE', items: [], note: (e as Error).message };
  }
  try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), result })); } catch { /* cache is optional */ }
  return result;
}

/** Same story syndicated on several domains: keep one per normalised title. */
export function dedupeArticles(items: GdeltArticle[]): GdeltArticle[] {
  const seen = new Set<string>();
  return items.filter((a) => {
    const key = a.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
