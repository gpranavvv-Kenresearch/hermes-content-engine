import type { SearchProvider } from '../contracts.js';
import { allowlistedSearch } from '../evidence/index.js';
import { PlanningSignalSchema, type PlanningSignal, type SourcePolicy } from '../schemas/index.js';
import { SearchSignalSource } from '../strategy/planning-signals.js';

/**
 * Fresh data: what has been published recently about this market.
 *
 *  - Government / regulatory items (purpose 'fact', so every URL passes the government allowlist):
 *    surfaced for review and used as 'govt_update' planning signals.
 *  - Market news and trend pages from anywhere not blocked (purpose 'planning'): planning signals
 *    only. They can suggest an angle; they are never facts and never cited.
 *
 * Neither group enters the post text yet. Whether a dated government item may become a source note
 * is a decision for a person; until then it is shown in the run report.
 */

/** Government domain suffixes per geography, used as provider-side hints (the allowlist re-checks every URL). */
const GOV_DOMAIN_HINTS: Record<string, string[]> = {
  'south africa': ['gov.za'],
  india: ['gov.in', 'nic.in'],
  australia: ['gov.au'],
  'united kingdom': ['gov.uk'],
  uk: ['gov.uk'],
  nigeria: ['gov.ng'],
  kenya: ['go.ke'],
  egypt: ['gov.eg'],
  brazil: ['gov.br'],
  singapore: ['gov.sg'],
  'united arab emirates': ['gov.ae'],
  uae: ['gov.ae'],
  'saudi arabia': ['gov.sa'],
  'united states': ['gov'],
  usa: ['gov'],
  canada: ['gc.ca', 'canada.ca'],
  indonesia: ['go.id'],
  japan: ['go.jp'],
  mexico: ['gob.mx'],
};

/** Government domain suffixes for a geography (search hints only: every URL is re-checked against the policy). */
export function govHintsFor(geography: string | undefined): string[] {
  return GOV_DOMAIN_HINTS[(geography ?? '').toLowerCase()] ?? [];
}

export interface FreshItem {
  title: string;
  url: string;
  publishedAt?: string;
  snippet?: string;
}

export interface FreshDataResult {
  government: FreshItem[];
  trends: FreshItem[];
  signals: PlanningSignal[];
  queries: { government: string; planning: string };
  discarded: number;
}

export interface FreshDataInput {
  provider: SearchProvider;
  geography: string | undefined;
  /** Short market name, for example "online classifieds and job portals". */
  market: string;
  policy: SourcePolicy;
  maxResults?: number;
}

const toSignal = (item: FreshItem, kind: PlanningSignal['signalKind']): PlanningSignal | null => {
  const parsed = PlanningSignalSchema.safeParse({ title: item.title.trim(), sourceUrl: item.url, signalKind: kind, purpose: 'planning' });
  return parsed.success ? parsed.data : null;
};

export async function gatherFreshData(input: FreshDataInput): Promise<FreshDataResult> {
  const max = input.maxResults ?? 6;
  const geo = input.geography ?? '';
  const queries = {
    government: `${geo} ${input.market} government regulation policy update`.replace(/\s+/g, ' ').trim(),
    planning: `${geo} ${input.market} market trends news`.replace(/\s+/g, ' ').trim(),
  };
  const hints = GOV_DOMAIN_HINTS[geo.toLowerCase()] ?? [];

  const [gov, trend] = await Promise.allSettled([
    allowlistedSearch({
      provider: input.provider,
      query: queries.government,
      purpose: 'fact',
      policy: input.policy,
      maxResults: max,
      extraIncludeDomains: hints,
    }),
    new SearchSignalSource({ provider: input.provider, signalKind: 'trend', blockedHosts: input.policy.blockedHosts }).fetchSignals({
      topic: queries.planning,
      maxResults: max,
    }),
  ]);
  if (gov.status === 'rejected' && trend.status === 'rejected') throw gov.reason;

  const government: FreshItem[] =
    gov.status === 'fulfilled'
      ? gov.value.hits.map((h) => ({ title: h.title, url: h.url, ...(h.publishedAt ? { publishedAt: h.publishedAt } : {}), snippet: h.snippet.slice(0, 200) }))
      : [];
  const trendSignals: PlanningSignal[] = trend.status === 'fulfilled' ? trend.value : [];
  const trends: FreshItem[] = trendSignals.map((s) => ({ title: s.title, url: s.sourceUrl }));

  const signals = [
    ...government.map((g) => toSignal(g, 'govt_update')),
    ...trendSignals,
  ].filter((s): s is PlanningSignal => s !== null);

  return { government, trends, signals, queries, discarded: gov.status === 'fulfilled' ? gov.value.discarded : 0 };
}
