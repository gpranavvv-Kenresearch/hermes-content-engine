import { describe, expect, it } from 'vitest';
import {
  computeCagr,
  deriveCagrFact,
  extractFacts,
  findGeographies,
  marketDefinitionFromTitle,
  markConflicts,
  splitSentences,
} from '../../src/evidence/fact-extractor.js';
import { FactSchema, type Fact } from '../../src/schemas/index.js';

const KEN = 'https://www.kenresearch.com/report/examplestan-widget-market';
const TITLE = 'Examplestan Widget Market Outlook to 2030 | Ken Research';
const NOW = '2026-10-13T00:00:00Z';
const EXTRA = ['Examplestan'];

const run = (text: string, over: Partial<Parameters<typeof extractFacts>[0]> = {}) =>
  extractFacts({ text, title: TITLE, url: KEN, retrievedAt: NOW, extraGeographies: EXTRA, ...over });

const SUMMARY =
  'The Examplestan Widget Market was valued at USD 4.2 billion in 2025 and is projected to reach USD 6.8 billion by 2030, expanding at a CAGR of 10.1% during 2025-2030.';

describe('extractFacts: market size and CAGR', () => {
  const facts = run(SUMMARY);

  it('extracts two market sizes and one CAGR, all schema-valid', () => {
    expect(facts).toHaveLength(3);
    for (const f of facts) expect(FactSchema.safeParse(f).success).toBe(true);
    const sizes = facts.filter((f) => f.metric === 'market_size');
    expect(sizes.map((f) => [f.value, f.unit, f.period]).sort()).toEqual([
      [4.2, 'USD billion', '2025'],
      [6.8, 'USD billion', '2030'],
    ]);
    const cagr = facts.find((f) => f.metric === 'cagr')!;
    expect(cagr).toMatchObject({ value: 10.1, unit: 'percent', period: '2025-2030', precision: 1 });
  });

  it('captures geography, market definition, precision, currency and quote', () => {
    const f = facts.find((x) => x.value === 4.2)!;
    expect(f.geography).toBe('Examplestan');
    expect(f.marketDefinition).toBe('Widget Market');
    expect(f.currency).toBe('USD');
    expect(f.precision).toBe(1);
    expect(f.sourceQuote).toContain('valued at USD 4.2 billion');
  });

  it('marks facts verified for Ken Research host with unambiguous period', () => {
    expect(facts.every((f) => f.verificationStatus === 'verified')).toBe(true);
  });

  it('is deterministic with stable ids', () => {
    const again = run(SUMMARY);
    expect(again.map((f) => f.id)).toEqual(facts.map((f) => f.id));
    expect(new Set(facts.map((f) => f.id)).size).toBe(3);
  });

  it('id changes with the source url', () => {
    const other = run(SUMMARY, { url: 'https://www.kenresearch.com/report/other' });
    expect(other[0]!.id).not.toBe(facts[0]!.id);
  });
});

describe('extractFacts: verification rules', () => {
  it('is unverified for a non-allowed host', () => {
    const f = run(SUMMARY, { url: 'https://example.org/blog' });
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => x.verificationStatus === 'unverified')).toBe(true);
  });

  it('is unverified for a competitor host', () => {
    const f = run(SUMMARY, { url: 'https://www.imarcgroup.com/x' });
    expect(f.every((x) => x.verificationStatus === 'unverified')).toBe(true);
  });

  it('is verified for government hosts', () => {
    const f = run('The sector reached USD 3 billion in 2024.', { url: 'https://stats.example.gov/report' });
    expect(f[0]?.verificationStatus).toBe('verified');
  });

  it('is unverified when the period is missing', () => {
    const f = run('The Examplestan widget market is worth USD 4.2 billion.');
    expect(f).toHaveLength(1);
    expect(f[0]!.period).toBeUndefined();
    expect(f[0]!.verificationStatus).toBe('unverified');
  });

  it('is unverified when the period is ambiguous', () => {
    const f = run('In 2024 and 2025 the widget market was worth USD 4.2 billion.');
    expect(f[0]!.verificationStatus).toBe('unverified');
  });

  it('marks all involved facts conflicting when values disagree', () => {
    const f = run(
      'The Examplestan widget market was valued at USD 4.2 billion in 2025. Elsewhere the Examplestan widget market was valued at USD 5.0 billion in 2025.',
    );
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.verificationStatus === 'conflicting')).toBe(true);
  });

  it('does not flag the same value expressed in different scale as conflict', () => {
    const f = run(
      'The Examplestan widget market was valued at USD 4.2 billion in 2025. The Examplestan widget market was valued at USD 4,200 million in 2025.',
    );
    expect(f).toHaveLength(2);
    expect(f.some((x) => x.verificationStatus === 'conflicting')).toBe(false);
  });

  it('does not flag different periods or geographies as conflict', () => {
    const f = run('The Examplestan widget market was valued at USD 4.2 billion in 2025. The India widget market was valued at USD 9 billion in 2025.');
    expect(f.some((x) => x.verificationStatus === 'conflicting')).toBe(false);
  });
});

describe('extractFacts: forms and non-facts', () => {
  it('handles $4.2B, bn, mn, trillion and suffix currency', () => {
    const f = run('The global widget market is valued at $4.2B in 2025. The Examplestan widget market is estimated at 350 mn USD in 2024. The industry will touch USD 1.1 trillion by 2035.');
    const units = f.map((x) => `${x.value} ${x.unit}`).sort();
    expect(units).toEqual(['1.1 USD trillion', '350 USD million', '4.2 USD billion']);
  });

  it('handles thousands separators and INR', () => {
    const f = run('The widget market reached INR 1,250 billion in 2025.');
    expect(f[0]).toMatchObject({ value: 1250, unit: 'INR billion', currency: 'INR', precision: 0 });
  });

  it('extracts "10.1% CAGR" and "compound annual growth rate of 8 percent"', () => {
    const a = run('Analysts expect a 10.1% CAGR from 2025 to 2030.');
    expect(a[0]).toMatchObject({ metric: 'cagr', value: 10.1, period: '2025-2030' });
    const b = run('The market shows a compound annual growth rate of 8 percent between 2024 and 2029.');
    expect(b[0]).toMatchObject({ metric: 'cagr', value: 8, period: '2024-2029', precision: 0 });
  });

  it('supports two-digit range ends with a dash only', () => {
    expect(run('The widget market grows at a CAGR of 6.5% over 2025-30.')[0]!.period).toBe('2025-2030');
    expect(run('A CAGR of 6.5% was seen, 2025 to 30 firms joined.')[0]!.period).toBe('2025');
  });

  it('ignores percentages that are not growth rates and money not about a market', () => {
    expect(run('Domestic demand accounted for 62.5% of revenue in 2025.')).toHaveLength(0);
    expect(run('The company raised USD 5 million in 2024 from investors.')).toHaveLength(0);
    expect(run('Tickets cost 5 million rupees in 2024.')).toHaveLength(0);
  });

  it('ignores unsupported scales (crore/lakh) and bare money', () => {
    expect(run('The widget market is worth INR 4,000 crore in 2025.')).toHaveLength(0);
    expect(run('The widget market is worth USD 4200000000 in 2025.')).toHaveLength(0);
  });

  it('does not treat a year inside a figure as a period', () => {
    const f = run('The widget market is valued at USD 2,025 million.');
    expect(f[0]!.period).toBeUndefined();
  });

  it('every output passes FactSchema even with odd titles', () => {
    for (const f of run(SUMMARY, { title: '' })) expect(FactSchema.safeParse(f).success).toBe(true);
  });

  it('dedupes identical repeated sentences', () => {
    expect(run(`${SUMMARY} ${SUMMARY}`)).toHaveLength(3);
  });
});

describe('helpers', () => {
  it('finds geographies incl. aliases and avoids the pronoun "us"', () => {
    expect(findGeographies('Demand in the U.S. and India grew; tell us more')).toEqual(['United States', 'India']);
    expect(findGeographies('Saudi Arabia and the UAE')).toEqual(['Saudi Arabia', 'United Arab Emirates']);
    expect(findGeographies('nothing here', [])).toEqual([]);
    expect(findGeographies('Asia Pacific outlook')).toEqual(['Asia Pacific']);
  });

  it('derives geography from the url slug when not in the sentence', () => {
    const f = run('The widget market was worth USD 3 billion in 2025.', { title: 'Widget Market', url: 'https://www.kenresearch.com/report/india-widget-market' });
    expect(f[0]!.geography).toBe('India');
  });

  it('uses Global when the sentence says global', () => {
    const f = run('The global widget market was worth USD 3 billion in 2025.', { title: 'Widget Market' });
    expect(f[0]!.geography).toBe('Global');
  });

  it('derives market definition from titles', () => {
    expect(marketDefinitionFromTitle('Global Widget Market Size & Share Report 2030 - Ken Research')).toBe('Widget Market');
    expect(marketDefinitionFromTitle('India Smart Gadget Market Outlook to 2030')).toBe('Smart Gadget Market');
    expect(marketDefinitionFromTitle('Why gadgets are growing')).toBeUndefined();
  });

  it('splits sentences without breaking decimals or U.S.', () => {
    const s = splitSentences('Value was 4.2 billion in the U.S. last year. Next sentence here.');
    expect(s).toHaveLength(2);
    expect(s[0]).toContain('4.2 billion');
  });

  it('markConflicts leaves unrelated facts alone', () => {
    const [a] = run(SUMMARY);
    expect(markConflicts([a!])[0]!.verificationStatus).toBe('verified');
  });
});

describe('derived CAGR', () => {
  const facts = run(SUMMARY);
  const start = facts.find((f) => f.value === 4.2)!;
  const end = facts.find((f) => f.value === 6.8)!;

  it('computeCagr computes percent and rejects bad input', () => {
    expect(computeCagr(100, 200, 1)).toBeCloseTo(100);
    expect(computeCagr(4.2, 6.8, 5)).toBeCloseTo(10.1, 1);
    expect(computeCagr(0, 5, 5)).toBeUndefined();
    expect(computeCagr(5, 6, 0)).toBeUndefined();
  });

  it('deriveCagrFact builds a derived, schema-valid fact with its derivation', () => {
    const d = deriveCagrFact(start, end)!;
    expect(d.factType).toBe('derived');
    expect(d.derivation?.inputFactIds).toEqual([start.id, end.id]);
    expect(d.derivation?.formula).toContain('CAGR');
    expect(d.value).toBeCloseTo(10.1, 1);
    expect(d.period).toBe('2025-2030');
    expect(d.verificationStatus).toBe('verified');
    expect(FactSchema.safeParse(d).success).toBe(true);
  });

  it('converts units between inputs (million vs billion)', () => {
    const e2: Fact = { ...end, unit: 'USD million', value: 6800 };
    expect(deriveCagrFact(start, e2)!.value).toBeCloseTo(10.12, 1);
  });

  it('refuses mismatched currency, geography, order, non market_size or unverified-only', () => {
    expect(deriveCagrFact(start, { ...end, unit: 'INR billion' })).toBeNull();
    expect(deriveCagrFact(start, { ...end, geography: 'India' })).toBeNull();
    expect(deriveCagrFact(end, start)).toBeNull();
    expect(deriveCagrFact(start, { ...end, metric: 'cagr' })).toBeNull();
    expect(deriveCagrFact(start, { ...end, period: '2025-2030' })).toBeNull();
    expect(deriveCagrFact({ ...start, verificationStatus: 'unverified' }, end)!.verificationStatus).toBe('unverified');
  });
});
