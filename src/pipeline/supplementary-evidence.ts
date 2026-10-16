import type { LoadedConfig } from '../config/index.js';
import type { Fetcher, SearchProvider } from '../contracts.js';
import {
  allowlistedSearch,
  classifyUrl,
  createSafeFetcher,
  extractContent,
  extractNotes,
  validateFetchedSource,
} from '../evidence/index.js';
import type { Fact, SourceNote, SourceTier } from '../schemas/index.js';
import { selectBriefFacts } from '../strategy/brief-builder.js';
import { isStaleFact } from '../utils/years.js';
import { govHintsFor } from './fresh-data.js';
import { gatherEvidence } from './gather-evidence.js';

/**
 * Supplementary evidence, used only when the report page itself gives no verified figure from 2024 or later.
 * Everything found goes into ONE pack (facts and notes, each tagged with where it came from):
 *
 *  1. Ken Research and government pages about the same market (allowlisted search, purpose "fact"). Their figures are
 *     verified by the same extractor and keep their own source: another Ken Research report counts as Ken Research,
 *     a government page is named as itself and is never presented as Ken Research.
 *  2. With mode "all", other non-competitor pages (never a market-research publisher or a press-release wire):
 *     only neutral, number-free background (growth drivers, structure, shifts). No figure from such a page is ever used.
 *
 * Nothing here publishes anything. Every URL is classified against the source policy before it is fetched and again
 * after redirects.
 */

export type SupplementaryMode = 'ken-gov' | 'all';

export interface SupplementarySource {
  url: string;
  tier: SourceTier;
  name: string;
  facts: number;
  notes: number;
}

export interface SupplementaryResult {
  facts: Fact[];
  notes: SourceNote[];
  sources: SupplementarySource[];
  queries: string[];
  /** Pages that could not be read or were off-topic, with the reason. */
  skipped: Array<{ url: string; reason: string }>;
}

export interface SupplementaryOptions {
  provider: SearchProvider;
  config: LoadedConfig;
  /** Short market name, for example "APAC airport operations contract lifecycle management". */
  market: string;
  geography?: string | undefined;
  /** The report page itself (never searched again). */
  reportUrl: string;
  mode: SupplementaryMode;
  maxPages?: number;
  /** Test hooks. */
  fetcherFor?: (purpose: 'fact' | 'supplementary') => Fetcher;
  gather?: typeof gatherEvidence;
  now?: () => Date;
}

const GENERIC = new Set(['market', 'markets', 'report', 'reports', 'industry', 'size', 'share', 'analysis', 'trends', 'growth', 'global', 'forecast', 'outlook', 'companies', 'segmentation']);

export const marketWords = (market: string): string[] =>
  [...new Set((market.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !GENERIC.has(w)))];

const overlap = (text: string, words: readonly string[]): number => {
  const lower = text.toLowerCase();
  return words.filter((w) => lower.includes(w)).length;
};

const normUrl = (u: string): string => u.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

/** A readable name for a page: the short last segment of its title ("... | IATA"), else its host. */
export function sourceNameFor(title: string, host: string): string {
  const segments = title.split(/\s[|–—-]\s/).map((s) => s.trim()).filter(Boolean);
  const last = segments.at(-1);
  if (segments.length > 1 && last && last.length <= 40 && !/^(home|news|about|report|reports|market)$/i.test(last)) return last;
  return host.replace(/^www\./, '');
}

/** A Ken Research report's name: its title without the catalogue suffix. */
export function reportNameFor(title: string): string {
  return title
    .replace(/\s*[|–—-]\s*(?:\d{4}.*|Ken Research.*)$/i, '')
    .replace(/\s*(?:Market\s+Share,?\s*Companies\s*(?:&|and)\s*Trends\s+Report|Market\s+Report|Report)\b.*$/i, '')
    .replace(/\s+\d{4}\s*[-–]\s*\d{4}\s*$/, '')
    .replace(/\s+Market$/i, '')
    .trim();
}

export async function gatherSupplementaryEvidence(o: SupplementaryOptions): Promise<SupplementaryResult> {
  const policy = o.config.sourcePolicy;
  const maxPages = o.maxPages ?? 4;
  const gather = o.gather ?? gatherEvidence;
  const words = marketWords(o.market);
  // A page counts as being about this market when it shares at least half of the market's key words (3 at most).
  const need = Math.min(3, Math.max(1, Math.ceil(words.length / 2)));
  const geo = o.geography ? ` ${o.geography}` : '';
  const result: SupplementaryResult = { facts: [], notes: [], sources: [], queries: [], skipped: [] };
  let noteCounter = 0;
  const seen = new Set<string>([normUrl(o.reportUrl)]);

  // 1. Ken Research and government pages
  const qA = `${o.market}${geo} market size CAGR forecast growth drivers`;
  result.queries.push(qA);
  const a = await allowlistedSearch({ provider: o.provider, query: qA, purpose: 'fact', policy, maxResults: 8, extraIncludeDomains: govHintsFor(o.geography) });
  for (const hit of a.hits) {
    if (result.sources.length >= maxPages) break;
    if (seen.has(normUrl(hit.url))) continue;
    seen.add(normUrl(hit.url));
    const klass = classifyUrl(hit.url, 'fact', policy);
    const tier: SourceTier = klass.sourceType === 'ken_research' ? 'ken_research' : 'government';
    try {
      const got = await gather({ url: hit.url, config: o.config, ...(o.fetcherFor ? { fetcher: o.fetcherFor('fact') } : {}), ...(o.now ? { now: o.now } : {}) });
      const title = got.factSet.facts[0]?.sourceTitle || hit.title;
      const name = tier === 'ken_research' ? reportNameFor(title) || klass.host : sourceNameFor(title, klass.host);
      const facts = selectBriefFacts(got.factSet.facts)
        // A growth rate needs a range of years (2025-2032); one stuck on a single year cannot be stated correctly.
        .filter((f) => !(f.metric === 'cagr' && !/\d{4}\s*[-–]\s*\d{4}/.test(f.period ?? '')))
        .filter((f) => !isStaleFact(f) && overlap(`${f.sourceTitle} ${f.marketDefinition ?? ''} ${f.sourceQuote ?? ''}`, words) >= need)
        .slice(0, 4)
        .map((f): Fact => ({ ...f, sourceTier: tier, sourceName: name }));
      const notes = got.factSet.notes
        .filter((n) => overlap(`${title} ${n.text}`, words) >= need)
        .slice(0, 3)
        .map((n): SourceNote => ({ ...n, id: `S${++noteCounter}`, tier, sourceName: name }));
      if (facts.length === 0 && notes.length === 0) {
        result.skipped.push({ url: hit.url, reason: 'no verified 2024+ figure or relevant note about this market' });
        continue;
      }
      // The same report is often listed under two URLs: take it once.
      if (result.sources.some((s) => s.tier === tier && s.name === name)) {
        result.skipped.push({ url: hit.url, reason: `same source as an earlier page (${name})` });
        continue;
      }
      result.facts.push(...facts.filter((f) => !result.facts.some((g) => g.id === f.id)));
      result.notes.push(...notes);
      result.sources.push({ url: hit.url, tier, name, facts: facts.length, notes: notes.length });
    } catch (e) {
      result.skipped.push({ url: hit.url, reason: (e as Error).message.slice(0, 120) });
    }
  }

  // 2. other non-competitor pages: neutral, number-free background only
  const haveBackground = result.notes.length >= 3;
  if (o.mode === 'all' && !haveBackground) {
    const qB = `${o.market}${geo} market growth drivers trends outlook`;
    result.queries.push(qB);
    const fetcher = o.fetcherFor ? o.fetcherFor('supplementary') : createSafeFetcher({ policy, purpose: 'supplementary' });
    const raw = await o.provider.search({ query: qB, maxResults: 12, purpose: 'planning' });
    let pages = 0;
    for (const hit of raw) {
      if (pages >= maxPages || result.notes.length >= 8) break;
      if (seen.has(normUrl(hit.url))) continue;
      const klass = classifyUrl(hit.url, 'supplementary', policy);
      if (!klass.allowed || klass.sourceType !== 'other_named') continue; // competitors, wires, Ken/government (handled above)
      seen.add(normUrl(hit.url));
      pages++;
      try {
        const page = await fetcher(hit.url);
        const content = await extractContent(page.html, page.finalUrl);
        const check = validateFetchedSource(
          { requestedUrl: page.requestedUrl, finalUrl: page.finalUrl, ...(content.canonicalUrl ? { canonicalUrl: content.canonicalUrl } : {}) },
          'supplementary',
          policy,
          o.now ? { now: o.now() } : {},
        );
        if (!check.allowed) {
          result.skipped.push({ url: hit.url, reason: check.record.reason.slice(0, 120) });
          continue;
        }
        if (overlap(`${content.title} ${content.text.slice(0, 1500)}`, words) < need) {
          result.skipped.push({ url: hit.url, reason: 'page is not about this market' });
          continue;
        }
        const name = sourceNameFor(content.title, klass.host);
        const notes = extractNotes({ text: content.text, url: page.finalUrl, max: 4, competitors: o.config.competitors }).map(
          (n): SourceNote => ({ ...n, id: `S${++noteCounter}`, tier: 'other', sourceName: name }),
        );
        if (notes.length === 0) {
          result.skipped.push({ url: hit.url, reason: 'no usable number-free statements' });
          continue;
        }
        result.notes.push(...notes);
        result.sources.push({ url: page.finalUrl, tier: 'other', name, facts: 0, notes: notes.length });
      } catch (e) {
        result.skipped.push({ url: hit.url, reason: (e as Error).message.slice(0, 120) });
      }
    }
  }
  return result;
}
