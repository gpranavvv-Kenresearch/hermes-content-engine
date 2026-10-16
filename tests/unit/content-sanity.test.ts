import { describe, expect, it } from 'vitest';
import { checkContentSanity, sanityReport } from '../../src/validation/checks/content-sanity.js';
import { sampleFact } from '../fixtures/validation/helpers.js';

const codes = (text: string, facts = [sampleFact], notes: string[] = []): string[] => checkContentSanity(text, facts, notes).map((i) => i.code);

// Real notes from the South Africa report page.
const NOTES = [
  'Growth will be supported by higher employer adoption of digital recruitment, expanding dealer and agency subscriptions and greater mobile engagement.',
  'Competitive remedies should improve access for smaller agencies and dealers, although leading portals will retain advantages in traffic, inventory and proprietary matching data.',
  'Identity, employer, dealership and agency verification can be sold through premium subscriptions, per-check charges and trust badges.',
  'Platforms must integrate consent, document validation, secure messaging and complaint workflows before verification can become a scalable recurring-revenue product.',
];

// Points 3 and 4 of a real post: the same verification idea twice.
const DUPLICATE_POST = `Is the common assumption still true?

1. Ken Research identifies that the market will grow from USD 146.5 million in 2025 to USD 222.3 million by 2031. This steady expansion implies revenue depends on recurring business accounts.

2. Competitive remedies are set to improve access for smaller agencies and dealers, yet leading portals retain structural advantages in traffic and proprietary matching data.

3. Verification products, including identity and employer checks, can become scalable recurring-revenue streams across major verticals. However, this value capture is conditional on integrating consent, document validation and secure messaging workflows before the feature goes live.

4. Platforms must integrate consent, document validation, secure messaging and complaint workflows before verification can become a scalable recurring-revenue product. These infrastructure components are necessary to support premium subscriptions and per-check charges across the four major vertical categories.

Which vertical offers the best balance?

For decision-makers evaluating this market, review the full market breakdown here:
https://www.kenresearch.com/x?utm_source=linkedin

#KenResearch #SouthAfrica`;

// A real post that opened three bullets with the same stock phrase.
const REPEATED_POST = `Ken Research analysis shows the market is valued at USD 146.5 million in 2025.

Three things decision-makers should note before planning entry:

- Growth is supported by higher employer adoption of digital recruitment. For decision-makers, this favors platforms that can convert casual traffic into committed business clients.

- South Africa ranks as the largest monetized market among selected African peers. For decision-makers, this indicates a sizable and mature market.

- Qualified-application charges can supplement revenue. For decision-makers, this suggests opportunities to diversify monetization beyond subscriptions.

Which vertical offers the most efficient path?

#KenResearch`;

const GOOD_POST = `Ken Research puts the South Africa online classifieds market at USD 146.5 million in 2025.

1. Growth is supported by higher employer adoption of digital recruitment and expanding dealer subscriptions, which favors platforms with paid business accounts.

2. Leading portals keep advantages in traffic, inventory and proprietary matching data, even as remedies improve access for smaller agencies.

3. Verification can be sold through premium subscriptions and per-check charges, so trust becomes a product line.

Which vertical offers the most defensible position?

#KenResearch`;

describe('content sanity', () => {
  it('passes a clean, grounded post with no hard failures', () => {
    const issues = checkContentSanity(GOOD_POST, [{ ...sampleFact, value: 146.5, unit: 'USD million', period: '2025' }], NOTES);
    expect(issues.filter((i) => i.severity === 'hard_fail')).toEqual([]);
  });

  it('catches two points that say the same thing', () => {
    const hit = checkContentSanity(DUPLICATE_POST, [sampleFact], NOTES).find((i) => i.code === 'DUPLICATE_POINT');
    expect(hit?.severity).toBe('hard_fail');
    expect(hit?.detail).toMatchObject({ points: [3, 4] });
  });

  it('catches the same lead-in phrase repeated across points', () => {
    const hit = checkContentSanity(REPEATED_POST, [sampleFact], NOTES).find((i) => i.code === 'REPEATED_PHRASE');
    expect(hit?.severity).toBe('hard_fail');
    expect(String(hit?.detail?.phrase)).toContain('decision makers');
  });

  it('requires a verified figure when facts exist, and not otherwise', () => {
    const noFigure = 'Ken Research finds buyers weigh service above price.\n\n#KenResearch';
    expect(codes(noFigure)).toContain('NO_VERIFIED_FIGURE');
    expect(codes(noFigure, [])).not.toContain('NO_VERIFIED_FIGURE');
  });

  it('asks for the brand to be named next to a finding', () => {
    expect(codes('The market reached USD 4.2 billion in 2025.\n\n#KenResearch')).toContain('NO_ATTRIBUTION');
    expect(codes('According to Ken Research, the market reached USD 4.2 billion in 2025.')).not.toContain('NO_ATTRIBUTION');
    expect(codes('Ken Research finds the market reached USD 4.2 billion in 2025.')).not.toContain('NO_ATTRIBUTION');
  });

  it('flags a figure written with more decimals than the source', () => {
    const cagr = { ...sampleFact, id: 'F2', metric: 'cagr', value: 7.2, unit: 'percent', period: '2025-2031' };
    expect(codes('Ken Research projects a 7.20% CAGR.', [cagr])).toContain('FIGURE_PRECISION');
    expect(codes('Ken Research projects a 7.2% CAGR.', [cagr])).not.toContain('FIGURE_PRECISION');
    expect(codes('Ken Research projects a 7.20% CAGR.', [{ ...cagr, precision: 2 }])).not.toContain('FIGURE_PRECISION');
  });

  it('flags statements with no basis in the facts or notes', () => {
    const post = `Ken Research puts the market at USD 146.5 million.

1. Incumbents' data moats remain the primary defense against disruption in every consumer segment today.

2. Growth is supported by higher employer adoption of digital recruitment and expanding dealer subscriptions.`;
    const hit = checkContentSanity(post, [sampleFact], NOTES).find((i) => i.code === 'UNGROUNDED_SENTENCE');
    expect(hit?.severity).toBe('review');
    expect(JSON.stringify(hit?.detail)).toContain('moats');
    // a grounded sentence is not flagged on its own
    expect(codes('Ken Research puts the market at USD 146.5 million.\n\n1. Growth is supported by higher employer adoption of digital recruitment and expanding dealer subscriptions.', [sampleFact], NOTES)).not.toContain('UNGROUNDED_SENTENCE');
  });

  it('flags very long, choppy and identically-opened writing', () => {
    const long = `Ken Research notes ${'the market continues to expand across many segments and regions '.repeat(6)}for USD 4.2 billion.`;
    expect(codes(long)).toContain('LONG_SENTENCE');
    expect(codes('Ken Research says USD 4.2 billion. Growth is steady. Demand is up. Prices hold. Buyers wait for value.')).toContain('CHOPPY_SENTENCES');
    const same = `Ken Research finds USD 4.2 billion.\n\n1. Demand for premium widgets grows.\n\n2. Demand for service plans grows.\n\n3. Demand for spare parts grows.`;
    expect(codes(same)).toContain('REPETITIVE_OPENERS');
  });

  it('gives one row per check for the run report', () => {
    const rows = sanityReport(DUPLICATE_POST, [sampleFact], NOTES);
    expect(rows.map((r) => r.code)).toEqual([
      'DUPLICATE_POINT', 'LIST_COUNT_MISMATCH', 'REPEATED_PHRASE', 'NO_VERIFIED_FIGURE', 'NO_ATTRIBUTION', 'FIGURE_PRECISION',
      'UNGROUNDED_SENTENCE', 'LONG_SENTENCE', 'CHOPPY_SENTENCES', 'REPETITIVE_OPENERS',
    ]);
    expect(rows.find((r) => r.code === 'DUPLICATE_POINT')?.status).toBe('fail');
    expect(rows.find((r) => r.code === 'NO_VERIFIED_FIGURE')?.status).toBe('pass');
  });
});

describe('ungrounded sentences escalate', () => {
  const body = (extra: string) => `Ken Research puts the market at USD 146.5 million.

1. Growth is supported by higher employer adoption of digital recruitment and expanding dealer subscriptions.

${extra}`;
  const loose1 = '2. Incumbents data moats remain the primary defense against disruption in every consumer segment today.';
  const loose2 = '3. Investors should expect patience around exit timing because compounding value arrives late in forecasts.';

  it('is a warning for one loose sentence and a hard failure for two', () => {
    const one = checkContentSanity(body(loose1), [sampleFact], NOTES).find((i) => i.code === 'UNGROUNDED_SENTENCE');
    const two = checkContentSanity(body(`${loose1}\n\n${loose2}`), [sampleFact], NOTES).find((i) => i.code === 'UNGROUNDED_SENTENCE');
    expect(one?.severity).toBe('review');
    expect(two?.severity).toBe('hard_fail');
  });
});

describe('attribution verbs', () => {
  it.each(['values', 'forecasts', 'states', 'measures'])('accepts "Ken Research %s ..." as an attribution', (verb) => {
    expect(codes(`Ken Research ${verb} the market at USD 4.2 billion in 2025.`)).not.toContain('NO_ATTRIBUTION');
  });
});

describe('list count', () => {
  const post = (intro: string, bullets: number) =>
    `Ken Research puts the market at USD 146.5 million in 2025.\n\n${intro}\n\n${Array.from({ length: bullets }, (_, i) => `- Point number ${i + 1} about the report and what it means.`).join('\n\n')}\n\nWhich one matters most?\n\n#KenResearch`;

  it('fails when the intro promises three and the list has four (a real post)', () => {
    const hit = checkContentSanity(post('Three structural realities shape entry decisions now:', 4), [sampleFact], []).find((i) => i.code === 'LIST_COUNT_MISMATCH');
    expect(hit?.severity).toBe('hard_fail');
    expect(hit?.detail).toEqual({ promised: 3, found: 4 });
  });

  it('accepts matching counts, digits, and intros that name no count', () => {
    expect(codes(post('Three things decision-makers should note before planning entry:', 3))).not.toContain('LIST_COUNT_MISMATCH');
    expect(codes(post('Here are 4 key shifts to plan around:', 4))).not.toContain('LIST_COUNT_MISMATCH');
    expect(codes(post('What the research points to:', 3))).not.toContain('LIST_COUNT_MISMATCH');
    expect(codes(post('Two risks for new entrants:', 3))).toContain('LIST_COUNT_MISMATCH');
  });
});
