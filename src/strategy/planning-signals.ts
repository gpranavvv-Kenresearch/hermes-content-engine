import type { SearchProvider } from '../contracts.js';
import { sourcePolicy as defaultSourcePolicy } from '../config/source-policy.config.js';
import { PlanningSignalSchema, type PlanningSignal, type SourcePolicy } from '../schemas/index.js';
import { normalizeHost } from '../utils/normalize.js';

/**
 * PLANNING signals only. Everything returned here is a PlanningSignal
 * (purpose: 'planning'); nothing in src/strategy converts one into a Fact, a
 * citation or text that reaches the reader. They can suggest topics and angles.
 */

export interface SignalQuery {
  topic: string;
  maxResults?: number;
}

export interface SignalSource {
  readonly id: string;
  fetchSignals(query: SignalQuery): Promise<PlanningSignal[]>;
}

/** Placeholder for a later Google-Trends client (library unverified, intentionally not added). */
export interface TrendSource extends SignalSource {
  readonly kind: 'trend';
}

/** Dot-boundary host match: "x.example.com" is blocked by "example.com"; "notexample.com" is not. */
export function isBlockedHost(url: string, blockedHosts: readonly string[] = defaultSourcePolicy.blockedHosts): boolean {
  let host: string;
  try {
    host = normalizeHost(new URL(url).hostname);
  } catch {
    return true; // unparseable URLs are dropped, never surfaced
  }
  return blockedHosts.some((b) => {
    const base = normalizeHost(b);
    return host === base || host.endsWith(`.${base}`);
  });
}

function isApprovedFeedHost(url: string, policy: SourcePolicy): boolean {
  let host: string;
  try {
    host = normalizeHost(new URL(url).hostname);
  } catch {
    return false;
  }
  if (policy.blockedHosts.some((b) => host === b || host.endsWith(`.${b}`))) return false;
  const exact = [...policy.kenResearchHosts, ...policy.extraAllowedHosts];
  if (exact.some((b) => host === b || host.endsWith(`.${b}`))) return true;
  return policy.governmentHostPatterns.some((p) => new RegExp(p).test(host));
}

function topicTokens(topic: string): string[] {
  return topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function toSignal(title: string | undefined, link: string | undefined, kind: PlanningSignal['signalKind']): PlanningSignal | null {
  const parsed = PlanningSignalSchema.safeParse({
    title: (title ?? '').trim(),
    sourceUrl: (link ?? '').trim(),
    signalKind: kind,
    purpose: 'planning',
  });
  return parsed.success ? parsed.data : null;
}

function dedupe(signals: PlanningSignal[]): PlanningSignal[] {
  const seen = new Set<string>();
  return signals.filter((s) => (seen.has(s.sourceUrl) ? false : (seen.add(s.sourceUrl), true)));
}

export interface FeedParserLike {
  parseURL(url: string): Promise<{ items?: Array<{ title?: string; link?: string }> }>;
}

async function defaultParser(): Promise<FeedParserLike> {
  const mod = await import('rss-parser');
  const Parser = (mod as unknown as { default: new () => FeedParserLike }).default;
  return new Parser();
}

export interface RssSignalSourceOptions {
  id?: string;
  /** Approved government (or Ken Research) feed URLs. Others are rejected at construction. */
  feedUrls: string[];
  parser?: FeedParserLike;
  sourcePolicy?: SourcePolicy;
}

/** Government-feed updates as 'govt_update' planning signals. Feed hosts must pass the source policy. */
export class RssSignalSource implements SignalSource {
  readonly id: string;
  private readonly feedUrls: string[];
  private readonly parser: FeedParserLike | undefined;
  private readonly policy: SourcePolicy;

  constructor(options: RssSignalSourceOptions) {
    this.policy = options.sourcePolicy ?? defaultSourcePolicy;
    const rejected = options.feedUrls.filter((u) => !isApprovedFeedHost(u, this.policy));
    if (rejected.length > 0) {
      throw new Error(`RssSignalSource: feed hosts not approved by source policy: ${rejected.join(', ')}`);
    }
    this.id = options.id ?? 'rss-govt';
    this.feedUrls = options.feedUrls;
    this.parser = options.parser;
  }

  async fetchSignals(query: SignalQuery): Promise<PlanningSignal[]> {
    const parser = this.parser ?? (await defaultParser());
    const tokens = topicTokens(query.topic);
    const out: PlanningSignal[] = [];
    for (const feedUrl of this.feedUrls) {
      let feed;
      try {
        feed = await parser.parseURL(feedUrl);
      } catch {
        continue; // one bad feed must not stop the others
      }
      for (const item of feed.items ?? []) {
        if (!item.link || isBlockedHost(item.link, this.policy.blockedHosts)) continue;
        const hay = (item.title ?? '').toLowerCase();
        if (tokens.length > 0 && !tokens.some((t) => hay.includes(t))) continue;
        const s = toSignal(item.title, item.link, 'govt_update');
        if (s) out.push(s);
      }
    }
    return dedupe(out).slice(0, query.maxResults ?? 10);
  }
}

export interface SearchSignalSourceOptions {
  provider: SearchProvider;
  id?: string;
  signalKind?: Extract<PlanningSignal['signalKind'], 'serp_heading' | 'leader_angle' | 'trend'>;
  blockedHosts?: readonly string[];
}

/**
 * Search results as planning signals. This source declares purpose 'planning':
 * results are used to suggest topics only. Competitor-firm hits are dropped
 * before they leave this class.
 */
export class SearchSignalSource implements SignalSource {
  readonly id: string;
  readonly purpose = 'planning' as const;
  private readonly provider: SearchProvider;
  private readonly kind: NonNullable<SearchSignalSourceOptions['signalKind']>;
  private readonly blocked: readonly string[];

  constructor(options: SearchSignalSourceOptions) {
    this.provider = options.provider;
    this.id = options.id ?? `search-${options.provider.id}`;
    this.kind = options.signalKind ?? 'serp_heading';
    this.blocked = options.blockedHosts ?? defaultSourcePolicy.blockedHosts;
  }

  async fetchSignals(query: SignalQuery): Promise<PlanningSignal[]> {
    const max = query.maxResults ?? 10;
    const hits = await this.provider.search({ query: query.topic, maxResults: max * 2 });
    const out: PlanningSignal[] = [];
    for (const hit of hits) {
      if (isBlockedHost(hit.url, this.blocked)) continue;
      const s = toSignal(hit.title, hit.url, this.kind);
      if (s) out.push(s);
    }
    return dedupe(out).slice(0, max);
  }
}
