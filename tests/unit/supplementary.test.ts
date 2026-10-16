import { describe, expect, it } from 'vitest';
import type { Fetcher, SearchHit, SearchProvider } from '../../src/contracts.js';
import { classifyUrl, looksLikeResearchPublisher } from '../../src/evidence/source-validator.js';
import type { FactSet, SourceNote } from '../../src/schemas/index.js';
import { gatherSupplementaryEvidence, reportNameFor, sourceNameFor } from '../../src/pipeline/index.js';
import { factsSection } from '../../src/strategy/index.js';
import { checkSourceAttribution } from '../../src/validation/checks/source-attribution.js';
import { config, sampleFact } from '../fixtures/validation/helpers.js';

const policy = config.sourcePolicy;

describe("policy: the 'supplementary' purpose", () => {
  it('allows ordinary named sites, never a research publisher, a wire, or a listed competitor', () => {
    expect(classifyUrl('https://www.iata.org/en/pressroom/airports', 'supplementary', policy)).toMatchObject({ allowed: true, sourceType: 'other_named' });
    expect(classifyUrl('https://pmc.ncbi.nlm.nih.gov/articles/PMC7148862', 'supplementary', policy).allowed).toBe(true);
    for (const url of [
      'https://www.bonafideresearch.com/product/1',
      'https://www.marketdataforecast.com/market-reports/x',
      'https://www.prnewswire.com/news-releases/x',
      'https://www.openpr.com/news/1',
      'https://evolvancemarketresearch.com/reports/x',
    ]) {
      expect(classifyUrl(url, 'supplementary', policy).allowed, url).toBe(false);
    }
    expect(classifyUrl('https://www.imarcgroup.com/report', 'supplementary', policy)).toMatchObject({ allowed: false, sourceType: 'competitor_blocked' });
  });

  it('keeps Ken Research and government as such, and the other purposes unchanged', () => {
    expect(classifyUrl('https://www.kenresearch.com/x', 'supplementary', policy).sourceType).toBe('ken_research');
    expect(classifyUrl('https://www.dtic.gov.za/x', 'supplementary', policy).sourceType).toBe('government');
    expect(classifyUrl('https://www.iata.org/x', 'fact', policy).allowed).toBe(false);
    expect(classifyUrl('https://www.iata.org/x', 'planning', policy).sourceType).toBe('planning_other');
    expect(looksLikeResearchPublisher('iata.org')).toBe(false);
  });
});

describe('names', () => {
  it('names a page from its title suffix or its host, and a Ken report without the catalogue suffix', () => {
    expect(sourceNameFor('Airport traffic outlook | IATA', 'www.iata.org')).toBe('IATA');
    expect(sourceNameFor('Airport traffic outlook', 'www.iata.org')).toBe('iata.org');
    expect(reportNameFor('Global Contract Lifecycle Management (CLM) Software Market Share, Companies & Trends Report 2025-2032')).toBe('Global Contract Lifecycle Management (CLM) Software');
  });
});

const KEN_REPORT = 'https://www.kenresearch.com/industry-reports/global-clm-software-market';
const GOV_PAGE = 'https://www.dtic.gov.za/sectors/clm';
const OTHER_PAGE = 'https://www.contractassociation.org/outlook';
const BAD_PAGE = 'https://www.widgetmarketinsights.com/clm';

const fact = (over: Record<string, unknown>) => ({ ...sampleFact, ...over }) as typeof sampleFact;

function factSetFor(url: string, title: string, facts: ReturnType<typeof fact>[], notes: string[]): { factSet: FactSet; source: never; extractionMethod: string } {
  return {
    factSet: {
      itemId: 'x',
      reportUrl: url,
      facts: facts.map((f) => ({ ...f, sourceUrl: url, sourceTitle: title })),
      notes: notes.map((text, i) => ({ id: `N${i + 1}`, text, sourceUrl: url })),
      createdAt: '2026-10-14T00:00:00Z',
    },
    source: undefined as never,
    extractionMethod: 'fake',
  };
}

const html = (title: string, sentences: string[]): string => `<html><head><title>${title}</title></head><body><article><h1>${title}</h1>${sentences.map((s) => `<p>${s}</p>`).join('')}</article></body></html>`;

describe('gatherSupplementaryEvidence', () => {
  const searches: Array<{ query: string; includeDomains?: string[] }> = [];
  const provider = (hitsA: SearchHit[], hitsB: SearchHit[]): SearchProvider => ({
    id: 'fake',
    async search(q) {
      searches.push({ query: q.query, ...(q.includeDomains ? { includeDomains: q.includeDomains } : {}) });
      return q.includeDomains ? hitsA : hitsB;
    },
  });
  const hit = (url: string, title: string): SearchHit => ({ url, title, snippet: '' });

  const gather = async (opts: { url: string }) => {
    if (opts.url === KEN_REPORT) {
      return factSetFor(KEN_REPORT, 'Global Contract Lifecycle Management Software Market | Ken Research', [fact({ id: 'K1', value: 3.7, unit: 'USD billion', period: '2025', geography: 'Global' }), fact({ id: 'K2', value: 12, unit: 'percent', metric: 'cagr', period: '2020-2025', geography: 'Global' })], [
        'Contract lifecycle management platforms are moving from on-premise to cloud-native deployments across large enterprises.',
      ]);
    }
    return factSetFor(GOV_PAGE, 'Contract management in transport | Dept of Trade, Industry and Competition', [fact({ id: 'G1', value: 18, unit: 'percent', metric: 'cagr', period: '2025-2030', geography: 'South Africa' })], []);
  };

  const fetcherFor = (): Fetcher => async (url) => {
    const body = html('Contract lifecycle management outlook | Contract Association', [
      'Contract lifecycle management adoption is expanding as procurement teams seek better visibility across supplier agreements and renewal dates.',
      'Contract lifecycle management vendors increasingly differentiate through analytics, integrations with finance systems and automated clause review for regulated industries.',
      'Larger organisations consolidate their contract repositories first, while smaller teams adopt lightweight tools that connect to existing document storage.',
      'Buyers weigh implementation effort and integration depth more heavily than feature breadth when comparing contract lifecycle management platforms.',
    ]);
    return { requestedUrl: url, finalUrl: url, status: 200, html: body };
  };

  it('collects Ken Research and government pages with their own tier and name, dropping stale facts', async () => {
    const r = await gatherSupplementaryEvidence({
      provider: provider([hit(KEN_REPORT, 'Global CLM Software'), hit(GOV_PAGE, 'DTIC')], []),
      config,
      market: 'contract lifecycle management',
      geography: 'Asia Pacific',
      reportUrl: 'https://www.kenresearch.com/industry-reports/apac-airport-clm-market',
      mode: 'ken-gov',
      gather: gather as never,
    });
    const ken = r.facts.filter((f) => f.sourceTier === 'ken_research');
    expect(ken.map((f) => f.id)).toEqual(['K1']); // K2 starts in 2020: stale, never used
    expect(ken[0]!.sourceName).toBe('Global Contract Lifecycle Management Software');
    const gov = r.facts.find((f) => f.sourceTier === 'government');
    expect(gov).toMatchObject({ id: 'G1', sourceName: 'Dept of Trade, Industry and Competition' });
    expect(r.sources.map((s) => s.tier)).toEqual(['ken_research', 'government']);
    expect(r.notes.every((n) => n.id.startsWith('S') && n.tier)).toBe(true);
    // the search was restricted to allowed hosts, and no second (open) search happened in ken-gov mode
    expect(searches.filter((s) => s.includeDomains)).toHaveLength(1);
    expect(searches.at(-1)!.includeDomains).toEqual(expect.arrayContaining(['kenresearch.com']));
  });

  it("'all' mode adds neutral, number-free background from other pages and never reads a research publisher", async () => {
    searches.length = 0;
    const r = await gatherSupplementaryEvidence({
      provider: provider([], [hit(BAD_PAGE, 'Insights'), hit('https://www.prnewswire.com/x', 'PR'), hit(OTHER_PAGE, 'Outlook'), hit('https://www.imarcgroup.com/x', 'IMARC')]),
      config,
      market: 'airport operations contract lifecycle management',
      geography: 'Asia Pacific',
      reportUrl: 'https://www.kenresearch.com/industry-reports/apac-airport-clm-market',
      mode: 'all',
      gather: gather as never,
      fetcherFor,
    });
    expect(r.facts).toEqual([]); // nothing numeric is ever taken from "other" pages
    expect(r.sources).toEqual([expect.objectContaining({ tier: 'other', url: OTHER_PAGE, facts: 0 })]);
    expect(r.notes.length).toBeGreaterThan(0);
    expect(r.notes.every((n) => n.tier === 'other' && !/\d/.test(n.text))).toBe(true);
    expect(r.skipped).toEqual([]); // the research publisher and the wire were never even fetched
  });
});

describe('prompt: facts and notes carry their tier', () => {
  const gov = fact({ id: 'G1', value: 18, unit: 'percent', metric: 'cagr', sourceTier: 'government', sourceName: 'Dept of Trade' });
  const ken = fact({ id: 'K1', sourceTier: 'ken_research', sourceName: 'Global CLM Software', geography: 'Global' });
  const other: SourceNote = { id: 'S1', text: 'Buyers weigh integration depth above feature breadth.', sourceUrl: OTHER_PAGE, tier: 'other', sourceName: 'x' };

  it('shows the source of each external fact and the attribution rules', () => {
    const p = factsSection([gov, ken]);
    expect(p).toContain('source: Dept of Trade (government/regulatory)');
    expect(p).toContain('source: Ken Research report "Global CLM Software"');
    expect(p).toContain('Never attribute it to Ken Research');
    expect(p).toContain('state its scope');
  });

  it('puts other-source notes in a neutral, unattributed block and never names their source', () => {
    const p = factsSection([sampleFact], [{ id: 'N1', text: 'A note from the report page.' }, other]);
    expect(p).toContain('SOURCE NOTES (from the Ken Research report page)');
    expect(p).toContain('NEUTRAL INDUSTRY BACKGROUND');
    expect(p).toContain('[S1] Buyers weigh integration depth');
    expect(p).toContain('Do NOT write "according to"');
    expect(p.indexOf('[S1]')).toBeGreaterThan(p.indexOf('NEUTRAL INDUSTRY BACKGROUND'));
    expect(p).not.toContain('sourceName');
  });

  it('is unchanged for a run that only has report-page facts and notes', () => {
    const p = factsSection([sampleFact], [{ id: 'N1', text: 'A note.' }]);
    expect(p).not.toContain('NEUTRAL INDUSTRY BACKGROUND');
    expect(p).not.toContain('source:');
  });
});

describe('checkSourceAttribution', () => {
  const gov = fact({ id: 'G1', value: 18, unit: 'percent', metric: 'cagr', period: '2025', sourceTier: 'government', sourceName: 'Dept of Trade, Industry and Competition' });
  const ken = fact({ id: 'K1', value: 3.7, unit: 'USD billion', period: '2025', geography: 'Global', sourceTier: 'ken_research', sourceName: 'Global Contract Lifecycle Management Software' });
  const codes = (text: string, facts = [gov, ken], notes: SourceNote[] = []) => checkSourceAttribution(text, facts, notes).map((i) => i.code);

  it('requires a government figure to name its body', () => {
    expect(codes('Ken Research notes the segment grows 18% a year.')).toContain('SOURCE_NOT_NAMED');
    expect(codes('According to the Dept of Trade, Industry and Competition, the segment grows 18% a year.')).not.toContain('SOURCE_NOT_NAMED');
    expect(codes('Growth reached 18% in 2025, the Dept of Trade reports.')).not.toContain('SOURCE_NOT_NAMED'); // two of its name words are enough
  });

  it("requires another Ken Research report's figure to state its scope", () => {
    expect(codes('Ken Research puts the market at USD 3.7 billion in 2025.')).toContain('SOURCE_SCOPE_MISSING');
    expect(codes('Ken Research puts the global market at USD 3.7 billion in 2025.')).not.toContain('SOURCE_SCOPE_MISSING');
  });

  it('does not touch facts from the report page, and ignores a figure that is not in the text', () => {
    expect(checkSourceAttribution('Ken Research puts the market at 4.2 USD billion.', [sampleFact])).toEqual([]);
    expect(codes('Demand keeps rising across the region.')).toEqual([]);
    expect(codes('The rate is 118.5 in the index.')).toEqual([]); // 18 is not matched inside 118.5
  });

  it('never lets neutral background from another source be credited to Ken Research', () => {
    const other: SourceNote = { id: 'S1', text: 'Buyers weigh implementation effort and integration depth more heavily than feature breadth when comparing platforms.', sourceUrl: OTHER_PAGE, tier: 'other', sourceName: 'x' };
    const own: SourceNote = { id: 'N1', text: 'Premium segments are growing faster than entry level products.', sourceUrl: KEN_REPORT };
    expect(codes('Ken Research notes buyers weigh implementation effort and integration depth more heavily than feature breadth when comparing platforms.', [], [other, own])).toContain('MISATTRIBUTED_NOTE');
    expect(codes('Buyers weigh implementation effort and integration depth more heavily than feature breadth when comparing platforms.', [], [other, own])).not.toContain('MISATTRIBUTED_NOTE');
    expect(codes('Ken Research notes that premium segments are growing faster than entry level products.', [], [other, own])).not.toContain('MISATTRIBUTED_NOTE');
  });
});

describe('same number from several facts, and the same report listed twice', () => {
  const globalCagr = fact({ id: 'A', value: 13, unit: 'percent', metric: 'cagr', period: '2025', geography: 'Global', sourceTier: 'ken_research', sourceName: 'Global Contract Lifecycle Management Software' });
  const noGeo = fact({ id: 'B', value: 13, unit: 'percent', metric: 'cagr', period: '2032', geography: undefined, sourceTier: 'ken_research', sourceName: 'Global Contract Lifecycle Management Software' });

  it('accepts a sentence when any fact with that number is scoped correctly in it', () => {
    expect(checkSourceAttribution('Ken Research reports a 13.0% CAGR for its Global market.', [globalCagr, noGeo]).map((i) => i.code)).toEqual([]);
    expect(checkSourceAttribution('Ken Research reports a 13.0% CAGR for the market.', [globalCagr, noGeo]).map((i) => i.code)).toEqual(['SOURCE_SCOPE_MISSING']);
  });

  it('takes a report once even when two URLs lead to it', async () => {
    const hit = (url: string): SearchHit => ({ url, title: 'Global CLM', snippet: '' });
    const r = await gatherSupplementaryEvidence({
      provider: { id: 'f', search: async () => [hit('https://www.kenresearch.com/global-clm-software-market'), hit('https://www.kenresearch.com/industry-reports/global-clm-software-market')] },
      config,
      market: 'contract lifecycle management',
      reportUrl: 'https://www.kenresearch.com/industry-reports/apac-airport-clm-market',
      mode: 'ken-gov',
      gather: (async () =>
        factSetFor(KEN_REPORT, 'Global Contract Lifecycle Management Software Market | Ken Research', [fact({ id: 'K1', value: 3.7, unit: 'USD billion', period: '2025', geography: 'Global' })], [])) as never,
    });
    expect(r.sources).toHaveLength(1);
    expect(r.facts.map((f) => f.id)).toEqual(['K1']);
    expect(r.skipped[0]?.reason).toMatch(/same source/);
  });
});

describe('growth rates from other pages', () => {
  it('drops a CAGR that is tied to a single year, keeps one with a range', async () => {
    const r = await gatherSupplementaryEvidence({
      provider: { id: 'f', search: async () => [{ url: KEN_REPORT, title: 'Global CLM', snippet: '' }] },
      config,
      market: 'contract lifecycle management',
      reportUrl: 'https://www.kenresearch.com/industry-reports/apac-airport-clm-market',
      mode: 'ken-gov',
      gather: (async () =>
        factSetFor(KEN_REPORT, 'Global Contract Lifecycle Management Software Market | Ken Research', [
          fact({ id: 'C1', value: 13, unit: 'percent', metric: 'cagr', period: '2025' }),
          fact({ id: 'C2', value: 13, unit: 'percent', metric: 'cagr', period: '2032' }),
          fact({ id: 'C3', value: 13, unit: 'percent', metric: 'cagr', period: '2025-2032' }),
          fact({ id: 'M1', value: 5458, unit: 'USD million', metric: 'market_size', period: '2032' }),
        ], [])) as never,
    });
    expect(r.facts.map((f) => f.id).sort()).toEqual(['C3', 'M1']);
  });
});
