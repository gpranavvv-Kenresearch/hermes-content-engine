import { describe, expect, it } from 'vitest';
import { extractFacts } from '../../src/evidence/index.js';

// Sentences copied from a real Ken Research report page (South Africa Online Classifieds
// and Job Portals Market, retrieved 2026-10-13). The first live extraction got these wrong:
// it labelled the revenue ADDED over six years as the market size, and it dropped the 2031 size.
const URL_ = 'https://www.kenresearch.com/south-africa-online-classifieds-and-job-portals-market';
const TITLE = 'South Africa Online Classifieds and Job Portals Market Share, Companies & Trends Report 2025-2031';
const FROM_TO =
  'The South Africa Online Classifieds and Job Portals Market is projected to expand from USD 146.5 Mn in 2025 to USD 222.3 Mn by 2031, representing a forecast CAGR of 7.20%.';
const INCREMENT = 'The market is forecast to add USD 75.8 Mn of annual revenue between 2025 and 2031.';
const TABLE_ROW = 'Market Size USD 146.5 Mn USD 132.0 Mn USD 105.0 Mn USD 46.0 Mn USD 39.0 Mn';
const SEGMENT_CAGR = 'Fixed broadband recorded a 16.1% five-year CAGR, allowing platforms to invest in video verification.';

const extract = (text: string) => extractFacts({ text, title: TITLE, url: URL_, retrievedAt: '2026-10-13T09:46:40Z' });
const find = (facts: ReturnType<typeof extract>, metric: string, value: number) => facts.find((f) => f.metric === metric && f.value === value);

describe('"from USD A in Y1 to USD B by Y2, CAGR r%" sentences', () => {
  const facts = extract(FROM_TO);

  it('extracts both market sizes with their own years, verified', () => {
    expect(find(facts, 'market_size', 146.5)).toMatchObject({ unit: 'USD million', period: '2025', geography: 'South Africa', verificationStatus: 'verified' });
    expect(find(facts, 'market_size', 222.3)).toMatchObject({ unit: 'USD million', period: '2031', geography: 'South Africa', verificationStatus: 'verified' });
  });

  it('gives the CAGR the 2025-2031 period and verifies it because it matches the sizes', () => {
    expect(find(facts, 'cagr', 7.2)).toMatchObject({ unit: 'percent', period: '2025-2031', geography: 'South Africa', verificationStatus: 'verified' });
    expect(facts).toHaveLength(3);
  });

  it('keeps the CAGR unverified when it does not match the two sizes', () => {
    const wrong = extract(FROM_TO.replace('7.20%', '12.00%'));
    expect(find(wrong, 'cagr', 12)).toMatchObject({ verificationStatus: 'unverified' });
    // the sizes themselves are still read from their own words
    expect(find(wrong, 'market_size', 146.5)?.verificationStatus).toBe('verified');
  });

  it('does not invent a pair when years or units differ', () => {
    const noYears = extract('The Examplestan Widget Market is projected to expand from USD 146.5 Mn to USD 222.3 Mn, representing a forecast CAGR of 7.20%.');
    expect(find(noYears, 'cagr', 7.2)?.verificationStatus).toBe('unverified');
  });
});

describe('amounts that are a change, not the market size', () => {
  it('does not label "add USD 75.8 Mn of annual revenue" as a market size', () => {
    const facts = extract(INCREMENT);
    expect(facts.filter((f) => f.metric === 'market_size')).toEqual([]);
  });

  it('still reads a normal size sentence in the same text', () => {
    const facts = extract(`${INCREMENT} ${FROM_TO}`);
    expect(find(facts, 'market_size', 75.8)).toBeUndefined();
    expect(find(facts, 'market_size', 146.5)?.verificationStatus).toBe('verified');
  });

  it.each(['The market is expected to add USD 40 Mn in 2026.', 'The market saw an additional USD 40 Mn of revenue in 2026.', 'The market gained an incremental USD 40 Mn in 2026.'])(
    'ignores "%s"',
    (s) => {
      expect(extract(s).filter((f) => f.metric === 'market_size')).toEqual([]);
    },
  );
});

describe('table rows and segment figures stay unverified', () => {
  it('does not verify a bare table row or a segment CAGR', () => {
    const facts = extract(`${TABLE_ROW} ${SEGMENT_CAGR}`);
    expect(facts.every((f) => f.verificationStatus !== 'verified')).toBe(true);
  });
});
