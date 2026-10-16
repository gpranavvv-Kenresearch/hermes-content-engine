import { describe, expect, it } from 'vitest';
import { checkClaims } from '../../src/evidence/index.js';
import { factsSection, personaSection } from '../../src/strategy/prompts/common.js';
import { classifyOutcome, validateText } from '../../src/validation/index.js';
import { checkNarrativeClaims } from '../../src/validation/narrative-claims.js';
import { config, sampleFact, utmLink } from '../fixtures/validation/helpers.js';

const codes = (text: string, facts = [sampleFact]) => checkNarrativeClaims(text, facts).map((i) => i.code);

// Real drafts produced by the API chain in the first live run (2026-10-13). The
// numbers were all correct; the narrative around them was invented.
const LIVE_LINKEDIN = [
  'Growth is driven by regulatory tightening on widget efficiency and safety. Rising compliance costs create a barrier to entry, favoring firms that can invest in upgraded production lines.',
  'Supply is contracting while demand remains stable, generating scarcity that supports higher exit valuations.',
  'Over five years this CAGR nearly doubles market value, shifting the investment thesis from cash-flow harvesting to equity appreciation.',
].join(' ');
const LIVE_FACEBOOK =
  'The pace is underpinned by three observable drivers: accelerated digital integration in production lines, a shift toward locally sourced components prompted by recent trade policy, and a government-backed incentive program that lowers capital costs. The sector expands faster than the average manufacturing index.';
const LIVE_X =
  'Examplestan Widget Market hits $4.2B in 2025. A 10.1% CAGR (2025-2030) signals durable expansion. According to Ken Research: https://www.kenresearch.com/industry-reports/examplestan-widget-market';

describe('checkNarrativeClaims', () => {
  it('flags invented drivers, policy claims and supply/demand statements', () => {
    const issues = checkNarrativeClaims(LIVE_LINKEDIN, [sampleFact]);
    const narrative = issues.filter((i) => i.code === 'UNSUPPORTED_NARRATIVE_CLAIM');
    expect(narrative.length).toBeGreaterThanOrEqual(2);
    expect(narrative.every((i) => i.severity === 'hard_fail')).toBe(true);
    expect(narrative.map((i) => i.message).join(' ')).toMatch(/regulat/i);
    expect(narrative.map((i) => i.message).join(' ')).toMatch(/supply is|demand remains/i);
  });

  it('flags a growth multiple the facts never state', () => {
    expect(codes(LIVE_LINKEDIN)).toContain('UNSUPPORTED_MULTIPLIER_CLAIM');
  });

  it('flags causes, incentives and comparisons in the Facebook draft', () => {
    const issues = checkNarrativeClaims(LIVE_FACEBOOK, [sampleFact]);
    expect(issues.map((i) => i.code)).toContain('UNSUPPORTED_NARRATIVE_CLAIM');
    const reasons = issues.flatMap((i) => ((i.detail as { reasons?: string[] } | undefined)?.reasons ?? []));
    expect(reasons.join(' ')).toMatch(/cause or driver/);
    expect(reasons.join(' ')).toMatch(/incentive|policy|government/);
    expect(reasons.join(' ')).toMatch(/comparison/);
  });

  it('passes text that sticks to the supplied facts', () => {
    expect(codes(LIVE_X)).toEqual([]);
    expect(codes('Ken Research finds the Examplestan widget market reached USD 4.2 billion in 2025. That is the base for any entry decision.')).toEqual([]);
  });

  it('allows a term when the facts themselves contain it', () => {
    const regulatoryFact = { ...sampleFact, id: 'F9', sourceQuote: 'Growth is driven by regulatory change and new compliance rules.' };
    expect(codes('Growth is driven by regulatory change.', [regulatoryFact])).toEqual([]);
    // but a different unsupported term in the same text is still flagged
    expect(codes('Growth is driven by tariff cuts.', [regulatoryFact])).toContain('UNSUPPORTED_NARRATIVE_CLAIM');
  });

  it('does nothing when no facts are supplied (legacy audit has no facts)', () => {
    expect(checkNarrativeClaims(LIVE_LINKEDIN, [])).toEqual([]);
  });

  it('ignores URL text', () => {
    expect(codes('Read more: https://www.kenresearch.com/policy-and-regulation-outlook')).toEqual([]);
  });
});

describe('narrative claims in the full validator', () => {
  it('turns a numerically correct but invented-narrative draft into a hard fail that needs a rewrite', () => {
    const text = `Ken Research finds the Examplestan widget market reached USD 4.2 billion in 2025, driven by regulatory tightening. ${utmLink('x')} #Widgets`;
    const report = validateText({ draftId: 'd', platform: 'x', text, facts: [sampleFact], recentTexts: [], claimChecker: checkClaims }, config);
    expect(report.passed).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('UNSUPPORTED_NARRATIVE_CLAIM');
    expect(report.issues.map((i) => i.code)).not.toContain('UNSUPPORTED_NUMERIC_CLAIM');
    expect(classifyOutcome(report)).toBe('rewrite');
  });
});

describe('prompt discipline lines', () => {
  it('the facts block tells the model not to invent causes, policies or multiples', () => {
    const block = factsSection([sampleFact]);
    expect(block).toMatch(/Do not invent or imply causes, drivers/);
    expect(block).toMatch(/Do not describe growth as a multiple/);
    expect(block).toContain('Use no numbers other than the facts above');
  });

  it('the persona block forbids naming the audience in the text', () => {
    const block = personaSection(config.personas.find((p) => p.id === 'pe-vc')!);
    expect(block).toMatch(/Never name this audience/);
  });
});
