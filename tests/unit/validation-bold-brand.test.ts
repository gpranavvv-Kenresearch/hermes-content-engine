import { describe, expect, it } from 'vitest';
import { checkClaims } from '../../src/evidence/index.js';
import {
  boldFlags,
  formatForPlatform,
  fromUnicodeBold,
  hasUnicodeBold,
  isRangeBold,
  markdownBoldToUnicode,
  stripMarkdownBold,
  toPlain,
  toUnicodeBold,
} from '../../src/utils/bold.js';
import { findFigures } from '../../src/utils/figures.js';
import { applyFixers, ensureBoldFixer, stripBoldFixer, stripExtraBoldFixer } from '../../src/validation/fixers.js';
import { validateText } from '../../src/validation/validate-draft.js';
import { config, sampleFact, utmLink } from '../fixtures/validation/helpers.js';

// Keep coverage for the historical mandatory-bold mode, while the shared current
// Facebook/LinkedIn policy is exercised separately below.
const legacyConfig = { ...config, platformLimits: { ...config.platformLimits,
  facebook: { ...config.platformLimits.facebook, formatting: { ...config.platformLimits.facebook.formatting, boldBrand: true, boldFigures: true, selectiveBold: false } },
} };
const ctx = (platform: 'facebook' | 'linkedin' | 'x') => ({ platform, config: platform === 'facebook' ? legacyConfig : config });
const hard = (r: { issues: Array<{ severity: string; code: string }> }) => r.issues.filter((i) => i.severity === 'hard_fail').map((i) => i.code);
const codes = (r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code);

describe('unicode bold', () => {
  it('converts ASCII letters and digits only, and round-trips', () => {
    const bold = toUnicodeBold('Ken Research 7.2% (2025)');
    expect(bold).toBe('𝐊𝐞𝐧 𝐑𝐞𝐬𝐞𝐚𝐫𝐜𝐡 𝟕.𝟐% (𝟐𝟎𝟐𝟓)');
    expect(fromUnicodeBold(bold)).toBe('Ken Research 7.2% (2025)');
    expect(hasUnicodeBold(bold)).toBe(true);
    expect(hasUnicodeBold('plain')).toBe(false);
  });

  it('turns **markdown** into bold and drops unbalanced markers', () => {
    expect(markdownBoldToUnicode('**Ken Research** reports **7.2%**')).toBe('𝐊𝐞𝐧 𝐑𝐞𝐬𝐞𝐚𝐫𝐜𝐡 reports 𝟕.𝟐%');
    expect(markdownBoldToUnicode('stray ** marker')).toBe('stray  marker');
    expect(stripMarkdownBold('**a** and **b**')).toBe('a and b');
  });

  it('toPlain undoes both forms', () => {
    expect(toPlain('**Ken Research** 𝟕.𝟐%')).toBe('Ken Research 7.2%');
  });

  it('boldFlags aligns plain text and flags for markdown, Unicode bold, and emoji', () => {
    const v = boldFlags('a **b** 𝐜 😀 d');
    expect(v.plain).toBe('a b c 😀 d');
    expect(v.bold.length).toBe(v.plain.length);
    expect(v.bold[v.plain.indexOf('b')]).toBe(true);
    expect(v.bold[v.plain.indexOf('c')]).toBe(true);
    expect(v.bold[v.plain.indexOf('d')]).toBe(false);
    expect(isRangeBold(boldFlags('**Ken Research** x'), 0, 12)).toBe(true);
    expect(isRangeBold(boldFlags('**Ken** Research'), 0, 12)).toBe(false);
  });

  it('formatForPlatform converts on bold platforms and strips elsewhere', () => {
    expect(formatForPlatform('**x**', { boldBrand: true, boldFigures: true })).toBe('𝐱');
    expect(formatForPlatform('**x**', { boldBrand: false, boldFigures: false })).toBe('x');
  });
  it('removes accidental Markdown and Unicode bold from X brand names and figures', () => {
    const mixed = `**${toUnicodeBold('Ken Research')}** finds ${toUnicodeBold('7.2%')} growth. **USD 4.2 billion**`;
    const plain = 'Ken Research finds 7.2% growth. USD 4.2 billion';
    expect(formatForPlatform(mixed, config.platformLimits.x.formatting)).toBe(plain);
    expect(stripBoldFixer.fix(mixed, ctx('x'))).toBe(plain);
    expect(stripBoldFixer.fix(plain, ctx('x'))).toBe(plain);
    expect(config.platformLimits.x.formatting.boldBrand).toBe(false);
    expect(config.platformLimits.x.formatting.boldFigures).toBe(false);
  });
});

describe('findFigures', () => {
  it.each([
    ['USD 146.5 million in 2025', ['USD 146.5 million', '2025']],
    ['reached $146.5M this year', ['$146.5M']],
    ['146.5 USD million and 222.3 USD million', ['146.5 USD million', '222.3 USD million']],
    ['a 7.2% CAGR, up from 7.20 percent', ['7.2%', '7.20 percent']],
    ['4.2 billion people', ['4.2 billion']],
  ])('finds figures in %j', (text, expected) => {
    expect(findFigures(text).map((f) => f.text)).toEqual(expected);
  });

  it('treats years as figures (the reference post bolds them) but not counts, ranks or list numbers', () => {
    expect(findFigures('In 2025-2031 the top 5 of 12 firms ranked #1').map((f) => f.text)).toEqual(['2025', '2031']);
    expect(findFigures('1. Point one\n2. Point two')).toEqual([]);
  });
});

describe('ENSURE_BOLD / STRIP_BOLD fixers', () => {
  it('the approved Facebook policy matches LinkedIn selective emphasis', () => {
    expect(config.platformLimits.facebook.formatting).toEqual(config.platformLimits.linkedin.formatting);
    const text = 'Ken Research reports **USD 4.2 billion** in **2025**.';
    const fb = applyFixers(text, { platform: 'facebook', config }).text;
    const li = applyFixers(text, { platform: 'linkedin', config }).text;
    expect(fb).toBe(li);
    expect(fb).toBe('**Ken Research** reports **USD 4.2 billion** in 2025.');
  });
  it('keeps at most one short emphasis span on LinkedIn without bolding every figure', () => {
    const input = '**USD 4.2 billion** in **2025**; **Ken Research** reports **7.2%** growth.';
    const fixed = applyFixers(input, ctx('linkedin'));
    expect(fixed.text).toBe('**USD 4.2 billion** in 2025; **Ken Research** reports 7.2% growth.');
    expect(applyFixers(fixed.text, ctx('linkedin')).text).toBe(fixed.text);
    const final = formatForPlatform(fixed.text, config.platformLimits.linkedin.formatting);
    expect(final).toContain(toUnicodeBold('USD 4.2 billion'));
    expect(final).toContain(`2025; ${toUnicodeBold('Ken Research')} reports 7.2%`);
    expect(formatForPlatform(final, config.platformLimits.linkedin.formatting)).toBe(final);
  });
  it.each(['facebook', 'linkedin'] as const)('%s restores every brand mention without requiring figure bold', (platform) => {
    const input = 'Ken Research reports USD 290 million in 2025. Ken Research forecasts USD 530 million.\nReport: https://www.kenresearch.com/x';
    const fixed = applyFixers(input, { platform, config }).text;
    expect(fixed.match(/\*\*Ken Research\*\*/g)).toHaveLength(2);
    expect(fixed).toContain('reports USD 290 million in 2025.');
    const final = formatForPlatform(fixed, config.platformLimits[platform].formatting);
    expect(final.match(new RegExp(toUnicodeBold('Ken Research'), 'g'))).toHaveLength(2);
    expect(toPlain(final)).toBe(toPlain(input.replace('https://www.kenresearch.com/x', utmLink(platform).replace('/industry-reports/examplestan-widget-market', '/x'))));
    expect(formatForPlatform(final, config.platformLimits[platform].formatting)).toBe(final);
    const report = validateText({ draftId: 'brand', platform, text: input, facts: [], recentTexts: [], claimChecker: () => ({ issues: [], mappings: [] }), layout: 'short-narrative' }, config);
    expect(hard(report)).toContain('BRAND_NOT_BOLD');
    const corrected = validateText({ draftId: 'brand', platform, text: final, facts: [], recentTexts: [], claimChecker: () => ({ issues: [], mappings: [] }), layout: 'short-narrative' }, config);
    expect(codes(corrected)).not.toContain('BRAND_NOT_BOLD');
    expect(codes(corrected)).not.toContain('FIGURE_NOT_BOLD');
  });
  it('keeps brand emphasis separate from optional figure emphasis after Unicode round trips', () => {
    const f = config.platformLimits.linkedin.formatting;
    const input = '**Ken Research** **USD 120 million** and **9.2%**. **Ken Research** again.';
    const once = formatForPlatform(input, f);
    expect(once).toContain(`${toUnicodeBold('Ken Research')} ${toUnicodeBold('USD 120 million')} and 9.2%.`);
    expect(once.match(new RegExp(toUnicodeBold('Ken Research'), 'g'))).toHaveLength(2);
    expect(formatForPlatform(once, f)).toBe(once);
    expect(applyFixers(once, ctx('linkedin')).text).toContain('**Ken Research** again.');
  });
  it('uses the configured brand when formatting a different brand', () => {
    const f = config.platformLimits.linkedin.formatting;
    const once = formatForPlatform('**Example Analytics** reports **7.2%**. **Example Analytics** again.', f, 'Example Analytics');
    expect(once.match(new RegExp(toUnicodeBold('Example Analytics'), 'g'))).toHaveLength(2);
    expect(formatForPlatform(once, f, 'Example Analytics')).toBe(once);
  });
  it('bolds the brand and every figure on Facebook, and leaves links and existing bold alone', () => {
    const input = `Ken Research reports USD 4.2 billion and a 7.2% CAGR. **Ken Research** again. ${utmLink('facebook')}`;
    const out = ensureBoldFixer.fix(input, ctx('facebook'));
    expect(out).toContain('**Ken Research** reports **USD 4.2 billion** and a **7.2%** CAGR.');
    expect(out).toContain('**Ken Research** again.');
    expect(out).not.toContain('****');
    expect(out).toContain(utmLink('facebook'));
  });

  it('is idempotent', () => {
    const once = ensureBoldFixer.fix('Ken Research says 7.2% and USD 4.2 billion.', ctx('linkedin'));
    expect(ensureBoldFixer.fix(once, ctx('linkedin'))).toBe(once);
  });

  it('does nothing on a plain platform, where STRIP_BOLD removes the asterisks instead', () => {
    expect(ensureBoldFixer.fix('Ken Research 7.2%', ctx('x'))).toBe('Ken Research 7.2%');
    expect(stripBoldFixer.fix('**Ken Research** 7.2%', ctx('x'))).toBe('Ken Research 7.2%');
    expect(stripBoldFixer.fix('**Ken Research**', ctx('facebook'))).toBe('**Ken Research**');
  });

  it('STRIP_EXTRA_BOLD removes bold that is neither the brand nor a figure, and keeps the rest', () => {
    const input = 'How does **7.20%** reshape the **South Africa online classifieds market** by **2031**? **Ken Research** says **a clear shift**.';
    const out = stripExtraBoldFixer.fix(input, ctx('facebook'));
    expect(out).toBe('How does **7.20%** reshape the South Africa online classifieds market by **2031**? **Ken Research** says a clear shift.');
    expect(stripExtraBoldFixer.fix(out, ctx('facebook'))).toBe(out);
    expect(stripExtraBoldFixer.fix(input, ctx('x'))).toBe(input);
  });

  it('is part of applyFixers and reports what it did', () => {
    const r = applyFixers('Ken Research: 7.2%', ctx('facebook'));
    expect(r.text).toBe('**Ken Research**: **7.2%**');
    expect(r.applied.map((a) => a.id)).toContain('ENSURE_BOLD');
  });
});

describe('brand and bold rules in the validator', () => {
  // A well-formed Facebook post in the house layout: hook question, numbered points, closing question, link, hashtags.
  const body = (brand: string, fig: string) =>
    [
      'Is the Examplestan widget market still growing?',
      `1. ${brand} finds the market reached ${fig} in **2025**.`,
      '2. Buyers weigh service coverage above price.',
      '3. Local assembly is gaining ground.',
      'What would change your entry plan?',
      utmLink('facebook'),
      '#KenResearch #A #B #C #D #E',
    ].join('\n\n');
  const run = (platform: 'facebook' | 'linkedin' | 'x' | 'blog', text: string) =>
    validateText({ draftId: 'd', platform, text, facts: [sampleFact], recentTexts: [], claimChecker: checkClaims, layout: 'numbered-points' }, platform === 'facebook' ? legacyConfig : config);

  it('requires the brand name on every platform', () => {
    const r = run('x', `The Examplestan widget market grew. ${utmLink('x')} #A`);
    expect(hard(r)).toContain('MISSING_BRAND_MENTION');
    expect(hard(run('x', `Ken Research notes growth. ${utmLink('x')} #A`))).not.toContain('MISSING_BRAND_MENTION');
  });
  it.each(['x', 'facebook', 'linkedin'] as const)('%s does not accept branding only in hashtags, URLs or report-link labels', (platform) => {
    for (const label of ['Read the Ken Research report:', 'Ken Research report:', 'For decision-makers, Ken Research analysis shows the full market breakdown:']) {
      const text = `The Examplestan widget market reached USD 4.2 billion in 2025.\n\n${label}\n${utmLink(platform)}\n#KenResearch`;
      expect(hard(run(platform, text))).toContain('MISSING_BRAND_MENTION');
    }
    const inline = `The Examplestan widget market reached USD 4.2 billion in 2025.\nRead the Ken Research report: ${utmLink(platform)} #KenResearch`;
    expect(hard(run(platform, inline))).toContain('MISSING_BRAND_MENTION');
    const attributed = `Ken Research finds the Examplestan widget market reached USD 4.2 billion in 2025. ${utmLink(platform)} #Widgets`;
    expect(hard(run(platform, attributed))).not.toContain('MISSING_BRAND_MENTION');
  });

  it('on Facebook the brand and figures must be bold: markdown or Unicode bold both count', () => {
    expect(hard(run('facebook', body('**Ken Research**', '**USD 4.2 billion**')))).toEqual([]);
    expect(hard(run('facebook', body(toUnicodeBold('Ken Research'), toUnicodeBold('USD 4.2 billion'))))).toEqual([]);
    expect(hard(run('facebook', body('Ken Research', '**USD 4.2 billion**')))).toEqual(['BRAND_NOT_BOLD']);
    expect(hard(run('facebook', body('**Ken Research**', 'USD 4.2 billion')))).toEqual(['FIGURE_NOT_BOLD']);
  });

  it('a bold figure is still checked against the facts (bold digits do not hide a wrong number)', () => {
    const wrong = run('facebook', body('**Ken Research**', toUnicodeBold('USD 9.9 billion')));
    expect(hard(wrong)).toContain('UNSUPPORTED_NUMERIC_CLAIM');
  });

  it('X is plain text: bold markers are not required and the brand just has to be named', () => {
    expect(hard(run('x', `Ken Research finds USD 4.2 billion in 2025. ${utmLink('x')} #A`))).toEqual([]);
  });

  it('flags bold on anything that is not the brand or a figure (review only)', () => {
    const r = run('facebook', body('**Ken Research**', '**USD 4.2 billion**').replace('service coverage', '**service coverage**'));
    expect(codes(r)).toContain('UNEXPECTED_BOLD');
    expect(hard(r)).toEqual([]);
  });

  it('measures length on the FINAL text: bold characters count double', () => {
    const filler = 'word '.repeat(400); // 2000 chars
    const plainTotal = `**Ken Research** ${filler}${utmLink('facebook')} #A #B #C #D #E #F`;
    const r = run('facebook', plainTotal);
    // 2000 + link ~150 is under 2280 as plain markdown, but the converted text is longer
    expect(r.issues.some((i) => i.code === 'OVER_HARD_LIMIT')).toBe(false);
    // 120 bold 12-letter words: about 2,250 characters of markdown (under the cap), but each bold
    // letter is two UTF-16 units once converted, so the text that would be posted is ~3,000.
    const heavy = `${'**wordwordword** '.repeat(120)}**Ken Research** ${utmLink('facebook')} #A #B #C #D #E #F`;
    expect(heavy.length).toBeLessThan(2280);
    expect(hard(run('facebook', heavy))).toContain('OVER_HARD_LIMIT');
  });
});
