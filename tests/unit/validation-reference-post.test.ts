import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkClaims } from '../../src/evidence/index.js';
import type { Fact } from '../../src/schemas/index.js';
import { applyBold, applySpacers, boldFlags, formatForPlatform, toPlain } from '../../src/utils/bold.js';
import { findFigures } from '../../src/utils/figures.js';
import { applyFixers } from '../../src/validation/fixers.js';
import { validateText } from '../../src/validation/validate-draft.js';
import { config } from '../fixtures/validation/helpers.js';

/**
 * The historical reference (2026-10-13) remains valid under its original explicit layout.
 * New LinkedIn formats use one discussion question and selective emphasis. Only the link is swapped for
 * a Ken Research link with the LinkedIn UTM (the original used a lnkd.in short link).
 */
const original = readFileSync(new URL('../fixtures/style/linkedin-reference.txt', import.meta.url), 'utf8').trimEnd();
const LINK = 'https://www.kenresearch.com/australia-athletic-apparel-and-footwear-market?utm_source=linkedin&utm_medium=referral&utm_campaign=automation';
const post = original.replace('https://lnkd.in/gBXj7Rds', LINK);

// The two figures the reference post states, as verified facts, so the numeric checker has something to match.
const base = {
  factType: 'observed' as const,
  geography: 'Australia',
  sourceUrl: 'https://www.kenresearch.com/australia-athletic-apparel-and-footwear-market',
  sourceTitle: 'Australia Athletic Apparel and Footwear Market',
  sourceRetrievedAt: '2026-10-13T00:00:00Z',
  verificationStatus: 'verified' as const,
};
const facts: Fact[] = [
  { ...base, id: 'F_size', metric: 'market_size', value: 6982, unit: 'USD million', currency: 'USD', period: '2025' },
  { ...base, id: 'F_cagr', metric: 'cagr', value: 5.8, unit: 'percent', period: '2025-2032' },
];

const run = (text: string, platform: 'linkedin' | 'facebook' = 'linkedin') =>
  validateText({ draftId: 'ref', platform, text, facts, recentTexts: [], claimChecker: checkClaims, layout: 'numbered-points' }, config);

describe('the reference LinkedIn post', () => {
  it('passes every hard check and every layout flag', () => {
    const report = run(post);
    expect(report.issues.filter((i) => i.severity === 'hard_fail')).toEqual([]);
    const layoutCodes = ['MISSING_LIST_STRUCTURE', 'LIST_TOO_LONG', 'HOOK_NOT_QUESTION', 'MISSING_CLOSING_QUESTION', 'MISSING_BRAND_HASHTAG', 'UNEXPECTED_BOLD'];
    expect(report.issues.map((i) => i.code).filter((c) => layoutCodes.includes(c))).toEqual([]);
  });

  it('bolds currency, percentage AND years, and the brand', () => {
    const view = boldFlags(post);
    const figures = findFigures(view.plain).map((f) => f.text);
    expect(figures).toEqual(expect.arrayContaining(['USD 6,982 million', '2025', '5.80%', '2032']));
    // every figure in the reference post is bold
    for (const f of findFigures(view.plain)) {
      const inUrl = view.plain.slice(0, f.start).split('\n').pop()!.includes('http');
      if (!inUrl) expect(view.bold.slice(f.start, f.end).some(Boolean), `figure ${f.text}`).toBe(true);
    }
  });

  it('uses U+2800 on its spacer lines, and our spacing step reproduces them from blank lines', () => {
    expect(original).toContain('\n⠀\n');
    const blankVersion = original.replaceAll('⠀', '');
    expect(applySpacers(blankVersion, config.platformLimits.linkedin.formatting).split('\n').filter((l) => l === '⠀').length).toBeGreaterThan(5);
    // idempotent
    const once = applySpacers(blankVersion, config.platformLimits.linkedin.formatting);
    expect(applySpacers(once, config.platformLimits.linkedin.formatting)).toBe(once);
  });

  it('automatically bolds the brand while keeping unselected figures plain in new LinkedIn output', () => {
    const plainText = toPlain(post);
    expect(plainText).not.toMatch(/[\u{1D400}-\u{1D7FF}]/u);
    expect(plainText).not.toContain('⠀');
    const fixed = applyFixers(plainText, { platform: 'linkedin', config });
    const final = formatForPlatform(fixed.text, config.platformLimits.linkedin.formatting);
    expect(final).toContain('2025');
    expect(final).toContain('𝐊𝐞𝐧 𝐑𝐞𝐬𝐞𝐚𝐫𝐜𝐡 data');
    expect(final).toContain('5.80%');
    expect(final).not.toContain('𝟐𝟎𝟐𝟓');
    expect(final).toContain('⠀');
    // the fixed text passes the same hard checks
    expect(run(final).issues.filter((i) => i.severity === 'hard_fail')).toEqual([]);
  });

  it('the same layout is accepted on Facebook (assumed to share the house style)', () => {
    const fb = post.replace('utm_source=linkedin', 'utm_source=facebook') + ' #A #B #C #D #E';
    expect(run(fb, 'facebook').issues.filter((i) => i.severity === 'hard_fail')).toEqual([]);
  });

  it('is rejected when the numbered points are replaced by one paragraph', () => {
    const flat = toPlain(post).replace(/^\d\.\s/gm, '').replace(/\n\n/g, ' ');
    const report = run(applyBold(flat, config.platformLimits.linkedin.formatting));
    expect(report.issues.map((i) => i.code)).toContain('MISSING_LIST_STRUCTURE');
  });
});
