import { describe, expect, it } from 'vitest';
import type { SearchProvider } from '../../src/contracts.js';
import { campaigns } from '../../src/config/campaign.config.js';
import { PlanningSignalSchema } from '../../src/schemas/index.js';
import { selectPersona } from '../../src/strategy/persona-selector.js';
import { RssSignalSource, SearchSignalSource, isBlockedHost } from '../../src/strategy/planning-signals.js';
import { loadFacts } from '../fixtures/strategy/load.js';

const facts = loadFacts();
const authority = campaigns.find((c) => c.id === 'authority-insights')!;
const evergreen = campaigns.find((c) => c.id === 'evergreen-pillars')!;

describe('selectPersona', () => {
  it('picks pe-vc for growth/CAGR heavy facts and records why', () => {
    const growth = facts.filter((f) => ['F2', 'F3'].includes(f.id));
    const r = selectPersona({ campaign: authority, facts: growth, itemMeta: { title: 'Examplestan Widget Market' } });
    expect(r.personaId).toBe('pe-vc');
    expect(r.reason).toMatch(/growth/i);
  });

  it('picks strategy-head for regulatory titles', () => {
    const r = selectPersona({
      campaign: authority,
      facts: [facts[0]!, facts[3]!, facts[0]!].slice(0, 2),
      itemMeta: { title: 'Examplestan widget regulation and subsidy policy' },
    });
    expect(r.personaId).toBe('strategy-head');
    expect(r.reason).toMatch(/regulatory/i);
  });

  it('picks cxo for headline-driven items', () => {
    const r = selectPersona({ campaign: authority, facts: [facts[0]!], itemMeta: { title: 'Examplestan widget makers announce record launch' } });
    expect(r.personaId).toBe('cxo');
  });

  it('never leaves the campaign persona pool', () => {
    const r = selectPersona({ campaign: evergreen, facts: [facts[0]!], itemMeta: { title: 'Examplestan launch record', headlineDriven: true } });
    expect(evergreen.personaIds).toContain(r.personaId);
    expect(r.personaId).not.toBe('cxo');
  });

  it('is deterministic and defaults to the first persona with a recorded reason', () => {
    const a = selectPersona({ campaign: authority, facts: [], itemMeta: { title: 'Plain title' } });
    const b = selectPersona({ campaign: authority, facts: [], itemMeta: { title: 'Plain title' } });
    expect(a).toEqual(b);
    expect(a.personaId).toBe(authority.personaIds[0]);
    expect(a.reason).toMatch(/defaulted/);
  });
});

describe('isBlockedHost', () => {
  const blocked = ['mordorintelligence.com'];
  it('matches the host and its subdomains on a dot boundary only', () => {
    expect(isBlockedHost('https://mordorintelligence.com/x', blocked)).toBe(true);
    expect(isBlockedHost('https://www.mordorintelligence.com/x', blocked)).toBe(true);
    expect(isBlockedHost('https://blog.mordorintelligence.com/x', blocked)).toBe(true);
    expect(isBlockedHost('https://notmordorintelligence.com/x', blocked)).toBe(false);
    expect(isBlockedHost('https://example.org/mordorintelligence.com', blocked)).toBe(false);
  });
  it('treats unparseable URLs as blocked', () => {
    expect(isBlockedHost('not a url', blocked)).toBe(true);
  });
  it('uses the config blocklist by default', () => {
    expect(isBlockedHost('https://www.imarcgroup.com/report')).toBe(true);
  });
});

describe('SearchSignalSource', () => {
  const provider: SearchProvider = {
    id: 'fake',
    async search() {
      return [
        { title: 'Widget demand questions', url: 'https://blog.example.org/widgets', snippet: 's' },
        { title: 'Widget Market Size', url: 'https://www.imarcgroup.com/widgets', snippet: 's' },
        { title: 'Widget Market Size', url: 'https://www.marketsandmarkets.com/widgets', snippet: 's' },
        { title: '', url: 'https://example.org/empty', snippet: 's' },
        { title: 'Dup', url: 'https://blog.example.org/widgets', snippet: 's' },
      ];
    },
  };

  it('drops competitor hits, invalid hits and duplicates; tags purpose planning', async () => {
    const src = new SearchSignalSource({ provider });
    const out = await src.fetchSignals({ topic: 'widgets' });
    expect(out).toHaveLength(1);
    expect(out[0]!.sourceUrl).toBe('https://blog.example.org/widgets');
    expect(PlanningSignalSchema.safeParse(out[0]).success).toBe(true);
    expect(out[0]!.purpose).toBe('planning');
    expect(src.purpose).toBe('planning');
  });
});

describe('RssSignalSource', () => {
  const parser = {
    async parseURL(url: string) {
      if (url.includes('broken')) throw new Error('boom');
      return {
        items: [
          { title: 'Widget subsidy scheme notified', link: 'https://widgets.gov.examplestan.gov.in/news/1' },
          { title: 'Unrelated fishing update', link: 'https://widgets.gov.examplestan.gov.in/news/2' },
          { title: 'Widget copycat post', link: 'https://www.technavio.com/x' },
        ],
      };
    },
  };

  it('returns govt_update signals filtered by topic and blocklist, tolerating a failing feed', async () => {
    const src = new RssSignalSource({
      feedUrls: ['https://widgets.gov.examplestan.gov.in/rss', 'https://broken.gov.in/rss'],
      parser,
    });
    const out = await src.fetchSignals({ topic: 'widget subsidy' });
    expect(out.map((s) => s.sourceUrl)).toEqual(['https://widgets.gov.examplestan.gov.in/news/1']);
    expect(out[0]!.signalKind).toBe('govt_update');
  });

  it('rejects feed hosts the source policy does not approve', () => {
    expect(() => new RssSignalSource({ feedUrls: ['https://www.imarcgroup.com/rss'], parser })).toThrow(/not approved/);
    expect(() => new RssSignalSource({ feedUrls: ['https://random-blog.example.org/rss'], parser })).toThrow(/not approved/);
  });
});
