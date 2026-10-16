import { describe, expect, it } from 'vitest';
import { checkOpeningQuote } from '../../src/validation/checks/source-quote.js';
import { validateText } from '../../src/validation/validate-draft.js';
import { config, noClaimIssues } from '../fixtures/validation/helpers.js';

const note = 'India provides the fastest percentage-growth profile, while Japan and South Korea retain strengths in automotive-grade electronics.';
const post = '“India provides the fastest percentage-growth profile.”\n\nKen Research describes the market.\n\nReport:\nhttps://www.kenresearch.com/x\n\nWhich capability matters most?\n\n#KenResearch #Market #Research';

describe('source-quote analysis', () => {
  it('accepts an exact excerpt with typographic quotes, whitespace and terminal punctuation', () => {
    expect(checkOpeningQuote(post, [note])).toEqual([]);
    expect(checkOpeningQuote(post.replace('“', '"').replace('”', '"'), [note.replace('provides the', 'provides\n the')])).toEqual([]);
  });
  it.each([
    post.replace('fastest', 'slowest'),
    post.replace('“India provides the fastest percentage-growth profile.”', 'India provides the fastest percentage-growth profile.'),
    post.replace('“India provides the fastest percentage-growth profile.”', '“India provides growth.”'),
  ])('rejects altered, missing or insufficient excerpts', (text) => {
    expect(checkOpeningQuote(text, [note]).map((i) => i.code)).toEqual(['UNSUPPORTED_SOURCE_QUOTE']);
  });
  it('does not match partial words', () => {
    expect(checkOpeningQuote(post, [note.replace('profile,', 'profiles,')])).toHaveLength(1);
  });
  it('wires the check into validation and excludes background notes', () => {
    const input = { draftId: 'quote', platform: 'linkedin' as const, text: post, facts: [], recentTexts: [], claimChecker: noClaimIssues, layout: 'source-quote-analysis', notes: [note] };
    const quoteCodes = (overrides: Partial<typeof input> = {}) => validateText({ ...input, ...overrides }, config).issues.filter((i) => i.code === 'UNSUPPORTED_SOURCE_QUOTE');
    expect(quoteCodes()).toEqual([]);
    expect(quoteCodes({ text: post.replace('fastest', 'slowest') })).toHaveLength(1);
    expect(quoteCodes({ layout: 'short-narrative', text: post.replace('fastest', 'slowest') })).toEqual([]);
    const report = validateText({ ...input, evidenceNotes: [{ id: 'N1', text: note, tier: 'other', sourceUrl: 'https://example.com' }] }, config);
    expect(report.issues.map((i) => i.code)).toContain('UNSUPPORTED_SOURCE_QUOTE');
  });
});
