import { describe, expect, it } from 'vitest';
import {
  canonicalTitle, cleanQueries, deriveKeywords, insertSearchContext, renderSearchContextBlock, renderSearchContextSheetText, summariseSeries, toQueryItems, type SearchContext,
} from '../src/signals/search-context.js';

describe('canonicalTitle', () => {
  it('turns a report URL used as the row title into the market name', () => {
    expect(canonicalTitle('https://www.kenresearch.com/industry-reports/united-states-short-term-vacation-rental-market')).toBe('United States Short Term Vacation Rental Market');
    expect(canonicalTitle('https://www.kenresearch.com/global-automotive-wrap-films-market?utm=1')).toBe('Global Automotive Wrap Films Market');
  });
  it('leaves real titles alone', () => {
    expect(canonicalTitle('Kenya Lubricants Market')).toBe('Kenya Lubricants Market');
  });
  it('derives country and head term from a URL title', () => {
    const k = deriveKeywords('https://www.kenresearch.com/industry-reports/united-states-short-term-vacation-rental-market');
    expect(k.geo).toBe('US');
    expect(k.head).toBe('short term vacation rental');
  });
});

describe('deriveKeywords', () => {
  it('splits country and head term', () => {
    const k = deriveKeywords('Kenya Lubricants Market');
    expect(k.country).toBe('Kenya');
    expect(k.geo).toBe('KE');
    expect(k.head).toBe('lubricants');
  });
  it('strips report tails and builds a broad-to-narrow ladder', () => {
    const k = deriveKeywords('Brazil Smart Cold Chain for Meat Export Market Outlook to 2030, Size, Share, Growth');
    expect(k.geo).toBe('BR');
    expect(k.head).toBe('smart cold chain for meat export');
    expect(k.ladder[0]).toBe('smart cold chain for meat export');
    expect(k.ladder).toContain('meat export');
    expect(k.ladder).toContain('export');
  });
  it('prefers the longest country name', () => {
    expect(deriveKeywords('South Africa Electric Bus Market').geo).toBe('ZA');
  });
  it('regional titles have no country, so only Worldwide runs', () => {
    const k = deriveKeywords('APAC Bone Grafts Market Outlook to 2030');
    expect(k.geo).toBeNull();
    expect(k.head).toBe('bone grafts');
  });
});

describe('summariseSeries', () => {
  const mk = (vals: number[], start = '2026-01-04'): Array<Record<string, string>> =>
    vals.map((v, i) => ({ Time: new Date(Date.parse(`${start}T00:00:00Z`) + i * 7 * 86_400_000).toISOString().slice(0, 10), kw: String(v) }));
  it('labels a rising series and finds the peak', () => {
    const s = summariseSeries(mk([10, 12, 11, 20, 22, 21, 40, 42, 41]), new Date('2027-06-01'));
    expect(s.label).toBe('rising');
    expect(s.changePct).toBeGreaterThan(100);
  });
  it('drops the unfinished newest week', () => {
    const rows = mk([50, 52, 51, 50, 52, 51, 50, 52, 5]);
    const last = rows[rows.length - 1]!.Time;
    const s = summariseSeries(rows, new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000));
    expect(s.droppedIncompleteWeek).toBe(true);
    expect(s.label).toBe('stable');
  });
  it('is unknown, not zero, when there are too few points', () => {
    expect(summariseSeries(mk([1, 2, 3])).label).toBe('unknown');
  });
});

describe('cleanQueries', () => {
  it('removes adult terms and accent duplicates, and reports why', () => {
    const { kept, dropped } = cleanQueries(toQueryItems([
      { query: 'lubrificante íntimo', a: '100', b: '4%' },
      { query: 'durex lubricants', a: '26', b: 'Breakout' },
      { query: 'óleo lubrificante', a: '60', b: '-40%' },
      { query: 'oleo lubrificante', a: '59', b: '-40%' },
      { query: 'filtro lubrificante', a: '74', b: '5%' },
    ]));
    expect(kept.map((q) => q.query)).toEqual(['óleo lubrificante', 'filtro lubrificante']);
    expect(dropped.map((d) => d.reason)).toEqual(['adult or unsafe term', 'adult or unsafe term', 'duplicate of an accent or case variant']);
  });
});

const ctx = (over: Partial<SearchContext['entries'][number]> = {}): SearchContext => ({
  schema: 'search-context/1', title: 'Kenya Lubricants Market', url: null, collectedAt: '2026-11-16T10:00:00.000Z', period: 'past 12 months', source: 'google-trends-browser',
  entries: [{
    scope: 'Kenya', geo: 'KE', keyword: 'engine oil', triedKeywords: ['engine oil'], status: 'OK', statusNote: '',
    trend: { label: 'rising', changePct: 18, peakMonth: 'Jul 2026', points: 52, droppedIncompleteWeek: true },
    top: [{ query: 'engine oil price', interest: 100, change: '5%' }],
    rising: [{ query: 'synthetic oil — kenya', interest: 8, change: '120%' }, { query: 'motorcycle oil', interest: 5, change: 'Breakout' }],
    regions: [{ region: 'Nairobi', interest: 100 }], dropped: [], runDir: null, ...over,
  }],
});

describe('renderSearchContextBlock', () => {
  it('blog block states it is search interest only, asks GPT to research too, and has no em dash', () => {
    const b = renderSearchContextBlock(ctx(), 'blog');
    expect(b).toContain('SEARCH DEMAND CONTEXT');
    expect(b).toContain('never present it as market size');
    expect(b).toContain('our own search-demand POC');
    expect(b).toContain('run your own search-demand POC');
    expect(b).toContain('Rising queries: synthetic oil, kenya (8, +120%); motorcycle oil (5, breakout)');
    expect(b).not.toMatch(/[—―]/);
  });
  it('image block is shorter and forbids printing search terms as statistics', () => {
    const b = renderSearchContextBlock(ctx(), 'image');
    expect(b).toContain('Do not print the search terms');
    expect(b).not.toContain('own search-demand POC');
    expect(b).not.toContain('Top regions');
  });
  it('returns empty text when nothing usable was collected', () => {
    expect(renderSearchContextBlock(null, 'blog')).toBe('');
    expect(renderSearchContextBlock(ctx({ status: 'DATA_UNAVAILABLE', trend: null, top: [], rising: [] }), 'blog')).toBe('');
  });
});

describe('renderSearchContextSheetText', () => {
  it('is a plain record for the sheet: queries, what was removed and why, no prompt instructions, no em dash', () => {
    const t = renderSearchContextSheetText(ctx({ dropped: [{ query: 'durex lubricants', reason: 'adult or unsafe term' }] }));
    expect(t).toContain('Google Trends, collected 2026-11-16');
    expect(t).toContain('[Kenya] "engine oil" - OK');
    expect(t).toContain('Top queries: engine oil price (100, +5%)');
    expect(t).toContain('Removed: durex lubricants (adult or unsafe term)');
    expect(t).not.toContain('SEARCH DEMAND CONTEXT');
    expect(t).not.toMatch(/[—―]/);
  });
  it('says plainly when an entry has no data', () => {
    const t = renderSearchContextSheetText(ctx({ status: 'DATA_UNAVAILABLE', statusNote: 'NO_DOWNLOADS', trend: null, top: [], rising: [] }));
    expect(t).toContain('No data: NO_DOWNLOADS');
  });
});

describe('rising list', () => {
  it('does not repeat a query already shown under Top', () => {
    const b = renderSearchContextBlock(ctx({ top: [{ query: 'shell lubricants', interest: 100, change: '10%' }], rising: [{ query: 'Shell Lubricants', interest: 100, change: '10%' }, { query: 'base oil', interest: 4, change: '80%' }] }), 'blog');
    expect(b).toContain('Rising queries: base oil (4, +80%)');
    expect(b).not.toContain('Rising queries: Shell');
  });
});

describe('insertSearchContext', () => {
  it('goes right after the Primary Report URL line', () => {
    const out = insertSearchContext('# INPUTS\n\nReport Title: X\n\nPrimary Report URL: https://k.com/x\n\n# NEXT', 'BLOCK');
    expect(out).toBe('# INPUTS\n\nReport Title: X\n\nPrimary Report URL: https://k.com/x\n\nBLOCK\n\n# NEXT');
  });
  it('appends instead of dropping when the prompt has no URL line', () => {
    expect(insertSearchContext('no inputs here', 'BLOCK')).toContain('BLOCK');
  });
});
