import { describe, expect, it } from 'vitest';
import { checkClaims, extractNumericClaims } from '../../src/evidence/claim-verifier.js';
import { deriveCagrFact } from '../../src/evidence/fact-extractor.js';
import { FactSchema, type Fact } from '../../src/schemas/index.js';

let n = 0;
function fact(over: Partial<Fact> & Pick<Fact, 'metric' | 'value' | 'unit'>): Fact {
  return FactSchema.parse({
    id: `f${++n}`,
    factType: 'observed',
    sourceUrl: 'https://www.kenresearch.com/report/examplestan-widget-market',
    sourceTitle: 'Examplestan Widget Market',
    sourceRetrievedAt: '2026-10-13T00:00:00Z',
    verificationStatus: 'verified',
    geography: 'Examplestan',
    ...over,
  });
}
const size25 = () => fact({ metric: 'market_size', value: 4.2, unit: 'USD billion', currency: 'USD', period: '2025', precision: 1 });
const size30 = () => fact({ metric: 'market_size', value: 6.8, unit: 'USD billion', currency: 'USD', period: '2030', precision: 1 });
const cagr = () => fact({ metric: 'cagr', value: 10.1, unit: 'percent', period: '2025-2030', precision: 1 });

const codes = (r: ReturnType<typeof checkClaims>) => r.issues.map((i) => i.code);

describe('claims that are ignored (false-positive guards)', () => {
  const cases: Array<[string, string]> = [
    ['years', 'In 2025 the firm opened a plant, and by 2030 it plans more. Founded in 1998.'],
    ['year ranges', 'The outlook covers 2025-2030 and FY2026.'],
    ['url with numbers', 'Read more at https://www.kenresearch.com/report/12345?utm_source=x&utm_campaign=q4-2025&id=987654'],
    ['bare domain path', 'See kenresearch.com/reports/widgets-2025 for details.'],
    ['hashtag Top5', 'Follow #Top5 and #Widgets2025 and #1 today.'],
    ['small count ways', 'Here are 3 ways to evaluate suppliers, plus 7 tips and 9 steps.'],
    ['list numbering', '1. First point\n2) Second point\n10. Tenth point'],
    ['phone-like', 'Call 1800 555 0199 or +91 98765 43210 or (022) 4000 1234 today.'],
    ['character count', 'This post is limited to 2,280 characters and 280 chars on X.'],
    ['iso and spelled dates', 'Published 2026-10-13 and updated 12 March 2025, also March 12, 2025 and 13/10/2026.'],
    ['times and versions', 'Meet at 10:30 on v2.5.1 of the tool.'],
    ['ids', 'Order ID 48211 and ref #9921, ticket 7731, code AB-4821, account 123456789012.'],
    ['plain small price', 'Costs $5 and $9.99 per month.'],
    ['top N list label', 'Top 10 companies shaped the sector.'],
    ['under-ten quantity', 'Only 5 companies and 8 firms entered.'],
    ['email and handle', 'Write to team4u2@example.com or @widgets2025.'],
  ];
  it.each(cases)('ignores %s', (_label, text) => {
    expect(extractNumericClaims(text)).toEqual([]);
    const r = checkClaims(text, []);
    expect(r.issues).toEqual([]);
    expect(r.mappings).toEqual([]);
  });

  it('still catches a real claim sitting next to ignorable numbers', () => {
    const t = 'Call 1800 555 0199 now. The market hit USD 4.2 billion in 2025 (#Top5).';
    const c = extractNumericClaims(t);
    expect(c.map((x) => x.raw)).toEqual(['USD 4.2 billion']);
  });
});

describe('claim extraction', () => {
  it('extracts money, percent, multiplier and noun quantities', () => {
    const t = 'The market is worth $4.2B, up 8.5% with a 3x rise, and 250 manufacturers compete; INR 4,000 million also.';
    const c = extractNumericClaims(t);
    expect(c.map((x) => [x.kind, x.raw])).toEqual([
      ['money', '$4.2B'],
      ['percent', '8.5%'],
      ['multiplier', '3x'],
      ['quantity', '250 manufacturers'],
      ['money', 'INR 4,000 million'],
    ]);
  });

  it('extracts both ends of a percent range', () => {
    expect(extractNumericClaims('Growth of 10-12% is expected.').map((x) => x.value)).toEqual([10, 12]);
  });

  it('extracts "350 mn USD" and currency-less scales', () => {
    const c = extractNumericClaims('Sales were 350 mn USD, from 1.4 billion units.');
    expect(c.map((x) => x.raw)).toEqual(['350 mn USD', '1.4 billion']);
    expect(c[0]!.currency).toBe('USD');
  });
});

describe('supported claims', () => {
  it('supports an exact match and records the fact id', () => {
    const f = size25();
    const r = checkClaims('The Examplestan widget market reached USD 4.2 billion in 2025.', [f]);
    expect(r.issues).toEqual([]);
    expect(r.mappings).toEqual([{ claim: 'USD 4.2 billion', status: 'supported', factId: f.id }]);
  });

  it('supports unit conversions (million, bn, B, %, percent)', () => {
    const f = size25();
    const c = cagr();
    for (const t of [
      'Examplestan reached USD 4,200 million in 2025.',
      'Examplestan reached $4.2bn in 2025.',
      'Examplestan reached 4.2B USD in 2025.',
      'Examplestan reached US$4.2 billion in 2025.',
    ]) {
      const r = checkClaims(t, [f]);
      expect(r.mappings[0]!.status, t).toBe('supported');
    }
    expect(checkClaims('A CAGR of 10.1 percent from 2025 to 2030 in Examplestan.', [c]).mappings[0]!.status).toBe('supported');
    expect(checkClaims('A CAGR of 10.1% over 2025-2030 in Examplestan.', [c]).mappings[0]!.status).toBe('supported');
  });

  it('allows coarser rounding but not invented precision', () => {
    const f = size25();
    expect(checkClaims('Examplestan hit USD 4 billion in 2025.', [f]).mappings[0]!.status).toBe('supported');
    expect(checkClaims('Examplestan hit USD 5 billion in 2025.', [f]).mappings[0]!.status).toBe('unsupported');
    const precise = fact({ metric: 'market_size', value: 4.23, unit: 'USD billion', currency: 'USD', period: '2025', precision: 2 });
    expect(checkClaims('Examplestan hit USD 4.2 billion in 2025.', [precise]).mappings[0]!.status).toBe('supported');
    expect(checkClaims('Examplestan hit USD 4.23 billion in 2025.', [f]).mappings[0]!.status).toBe('unsupported');
    expect(checkClaims('Examplestan hit USD 4.20 billion in 2025.', [f]).mappings[0]!.status).toBe('supported');
  });

  it('supports noun quantities from a matching fact', () => {
    const f = fact({ metric: 'count', value: 250, unit: 'manufacturers', period: '2025' });
    expect(checkClaims('Examplestan has 250 manufacturers in 2025.', [f]).mappings[0]!.status).toBe('supported');
    expect(checkClaims('Examplestan has 300 manufacturers in 2025.', [f]).mappings[0]!.status).toBe('unsupported');
  });
});

describe('unsupported claims', () => {
  it('hard-fails a number with no matching fact', () => {
    const r = checkClaims('The market reached USD 9.9 billion.', [size25()]);
    expect(r.mappings[0]!.status).toBe('unsupported');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: 'UNSUPPORTED_NUMERIC_CLAIM', severity: 'hard_fail' });
  });

  it('hard-fails with no facts at all', () => {
    expect(codes(checkClaims('Sales grew 12% to USD 1.1 trillion.', []))).toEqual(['UNSUPPORTED_NUMERIC_CLAIM', 'UNSUPPORTED_NUMERIC_CLAIM']);
  });

  it('does not match a percent claim against a money fact or vice versa', () => {
    expect(checkClaims('Growth hit 4.2%.', [size25()]).mappings[0]!.status).toBe('unsupported');
    expect(checkClaims('Worth USD 10.1 billion.', [cagr()]).mappings[0]!.status).toBe('unsupported');
  });

  it('does not match a different currency', () => {
    expect(checkClaims('Examplestan reached INR 4.2 billion in 2025.', [size25()]).mappings[0]!.status).toBe('unsupported');
  });
});

describe('context mismatches', () => {
  it('allows one shared region for three figures while keeping each period and scope correct', () => {
    const facts = [size25(), size30(), cagr()].map((f) => ({ ...f, geography: 'Asia Pacific' }));
    const text = 'The Asia-Pacific market was USD 4.2 billion in 2025 and is projected at USD 6.8 billion in 2030, a 10.1% CAGR over 2025-2030.';
    const accepted = checkClaims(text, facts);
    expect(accepted.issues).toEqual([]);
    expect(accepted.mappings).toHaveLength(3);
    expect(checkClaims(text.replace('Asia-Pacific', 'India'), facts).issues.map((i) => i.code)).toContain('FACT_CONTEXT_MISMATCH');
  });
  it('flags a different year than the fact period', () => {
    const r = checkClaims('Examplestan reached USD 4.2 billion in 2030.', [size25()]);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: 'FACT_CONTEXT_MISMATCH', severity: 'hard_fail' });
    expect(r.mappings[0]!.factId).toBeDefined();
  });

  it('flags a different geography', () => {
    const r = checkClaims('India reached USD 4.2 billion in 2025.', [size25()]);
    expect(codes(r)).toEqual(['FACT_CONTEXT_MISMATCH']);
  });

  it('flags "global" when the fact is country-specific', () => {
    expect(codes(checkClaims('The global market reached USD 4.2 billion in 2025.', [size25()]))).toEqual(['FACT_CONTEXT_MISMATCH']);
  });

  it('accepts a claim when a second fact fits the context', () => {
    const other = fact({ metric: 'market_size', value: 4.2, unit: 'USD billion', currency: 'USD', period: '2030', precision: 1 });
    const r = checkClaims('Examplestan reached USD 4.2 billion in 2030.', [size25(), other]);
    expect(r.issues).toEqual([]);
    expect(r.mappings[0]!.factId).toBe(other.id);
  });

  it('assigns years to the nearest claim in a two-claim sentence', () => {
    const r = checkClaims('Examplestan was worth USD 4.2 billion in 2025 and will reach USD 6.8 billion by 2030.', [size25(), size30()]);
    expect(r.issues).toEqual([]);
    expect(r.mappings.map((m) => m.status)).toEqual(['supported', 'supported']);
  });

  it('range facts accept years inside the range and reject others', () => {
    const c = cagr();
    expect(checkClaims('Examplestan grows at a CAGR of 10.1% to 2030.', [c]).issues).toEqual([]);
    expect(codes(checkClaims('Examplestan grows at a CAGR of 10.1% over 2024-2029.', [c]))).toEqual(['FACT_CONTEXT_MISMATCH']);
  });
});

describe('conflicting facts', () => {
  it('never silently picks one of two disagreeing facts', () => {
    const a = size25();
    const b = fact({ metric: 'market_size', value: 5.0, unit: 'USD billion', currency: 'USD', period: '2025', precision: 1 });
    const r = checkClaims('Examplestan reached USD 4.2 billion in 2025.', [a, b]);
    expect(r.mappings[0]!.status).toBe('conflicting');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: 'CONFLICTING_FACT', severity: 'hard_fail' });
  });

  it('honors facts already marked conflicting', () => {
    const a = { ...size25(), verificationStatus: 'conflicting' as const };
    expect(codes(checkClaims('Examplestan reached USD 4.2 billion in 2025.', [a]))).toEqual(['CONFLICTING_FACT']);
  });

  it('same value in different units is not a conflict', () => {
    const a = size25();
    const b = fact({ metric: 'market_size', value: 4200, unit: 'USD million', currency: 'USD', period: '2025', precision: 0 });
    expect(checkClaims('Examplestan reached USD 4.2 billion in 2025.', [a, b]).issues).toEqual([]);
  });
});

describe('unverified facts', () => {
  it('uses the fact but raises a review issue', () => {
    const f = { ...size25(), verificationStatus: 'unverified' as const };
    const r = checkClaims('Examplestan reached USD 4.2 billion in 2025.', [f]);
    expect(r.mappings[0]!.status).toBe('supported');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: 'UNVERIFIED_FACT_USED', severity: 'review' });
  });

  it('prefers a verified fact over an unverified duplicate', () => {
    const v = size25();
    const u = { ...size25(), id: 'dup', verificationStatus: 'unverified' as const };
    const r = checkClaims('Examplestan reached USD 4.2 billion in 2025.', [u, v]);
    expect(r.issues).toEqual([]);
    expect(r.mappings[0]!.factId).toBe(v.id);
  });
});

describe('derived values', () => {
  it('accepts a CAGR computed from two market sizes', () => {
    const r = checkClaims('Examplestan should compound at about 10.1% a year, a CAGR over 2025-2030.', [size25(), size30()]);
    expect(r.issues).toEqual([]);
    expect(r.mappings[0]!.status).toBe('derived');
    expect(r.mappings[0]!.note).toContain('years');
  });

  it('accepts total growth and multiples from the same inputs', () => {
    const facts = [size25(), size30()];
    expect(checkClaims('Examplestan grows 61.9% between 2025 and 2030.', facts).mappings[0]!.status).toBe('derived');
    expect(checkClaims('Examplestan grows 1.6x between 2025 and 2030.', facts).mappings[0]!.status).toBe('derived');
  });

  it('rejects a derived value when only one input exists', () => {
    const r = checkClaims('Examplestan has a CAGR of 10.1% over 2025-2030.', [size25()]);
    expect(r.mappings[0]!.status).toBe('unsupported');
  });

  it('rejects a derived value that does not match the math or the stated period', () => {
    const facts = [size25(), size30()];
    expect(checkClaims('Examplestan has a CAGR of 14.2% over 2025-2030.', facts).mappings[0]!.status).toBe('unsupported');
    expect(codes(checkClaims('Examplestan has a CAGR of 10.1% over 2026-2031.', facts))).toEqual(['FACT_CONTEXT_MISMATCH']);
  });

  it('accepts a stored derived fact only when its inputs are in the set', () => {
    const d = deriveCagrFact(size25(), size30())!;
    const withInputs = checkClaims('Examplestan has a CAGR of 10.1% over 2025-2030.', [d, ...[size25(), size30()].map((f, i) => ({ ...f, id: d.derivation!.inputFactIds[i]! }))]);
    expect(withInputs.mappings[0]!.status).toBe('derived');
    const without = checkClaims('Examplestan has a CAGR of 10.1% over 2025-2030.', [d]);
    expect(without.mappings[0]!.status).toBe('unsupported');
  });

  it('flags unverified derivation inputs for review', () => {
    const a = { ...size25(), verificationStatus: 'unverified' as const };
    const r = checkClaims('Examplestan grows 1.6x between 2025 and 2030.', [a, size30()]);
    expect(r.mappings[0]!.status).toBe('derived');
    expect(codes(r)).toEqual(['UNVERIFIED_FACT_USED']);
  });

  it('does not derive across geographies or currencies', () => {
    const other = fact({ metric: 'market_size', value: 6.8, unit: 'USD billion', currency: 'USD', period: '2030', precision: 1, geography: 'India' });
    expect(checkClaims('Growth of 1.6x between 2025 and 2030.', [size25(), other]).mappings[0]!.status).toBe('unsupported');
  });
});

describe('determinism and mixed drafts', () => {
  it('returns identical results on repeated runs', () => {
    const t = 'Examplestan reached USD 4.2 billion in 2025, 9.9% growth, 250 manufacturers.';
    const facts = [size25(), cagr()];
    expect(checkClaims(t, facts)).toEqual(checkClaims(t, facts));
  });

  it('reports each unsupported claim separately in a mixed draft', () => {
    const r = checkClaims('Examplestan reached USD 4.2 billion in 2025 with a 77% share and 3x demand. #Top5 https://x.com/a?b=12', [size25()]);
    expect(r.mappings.map((m) => m.status)).toEqual(['supported', 'unsupported', 'unsupported']);
    expect(codes(r)).toEqual(['UNSUPPORTED_NUMERIC_CLAIM', 'UNSUPPORTED_NUMERIC_CLAIM']);
  });
});
