import type { Collected, TrendItem } from './types.js';

const decode = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
const tag = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]!) : null;
};

export function parseTrendsRss(xml: string, geo: string, collectedAt: string, url: string): TrendItem[] {
  const items: TrendItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1]!;
    const news = [...block.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/gi)].map((n) => ({
      title: tag(n[1]!, 'ht:news_item_title') ?? '',
      url: tag(n[1]!, 'ht:news_item_url') ?? '',
      source: tag(n[1]!, 'ht:news_item_source'),
    }));
    items.push({
      title: tag(block, 'title') ?? '',
      approxTraffic: tag(block, 'ht:approx_traffic'),
      publishedAt: tag(block, 'pubDate'),
      news,
      provenance: { source: 'google-trends-rss', method: url, collectedAt, country: geo.toUpperCase(), language: null },
    });
  }
  return items;
}

/** Trending Now for one country. Not niche B2B demand and not volume: a freshness cue only. */
export async function trendsRss(geo: string, fetchImpl: typeof fetch = fetch): Promise<Collected<TrendItem>> {
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo.toUpperCase())}`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { status: res.status === 429 ? 'THROTTLED' : 'DATA_UNAVAILABLE', items: [], note: `HTTP ${res.status}` };
    const items = parseTrendsRss(await res.text(), geo, new Date().toISOString(), url);
    return { status: items.length ? 'OK' : 'EMPTY', items };
  } catch (e) {
    return { status: 'DATA_UNAVAILABLE', items: [], note: (e as Error).message };
  }
}

/** Keep only trends that mention one of the market terms (title or linked headlines). */
export function matchTrends(items: TrendItem[], terms: string[]): TrendItem[] {
  const needles = terms.map((t) => t.toLowerCase()).filter(Boolean);
  return items.filter((i) => {
    const hay = `${i.title} ${i.news.map((n) => n.title).join(' ')}`.toLowerCase();
    return needles.some((n) => hay.includes(n));
  });
}
