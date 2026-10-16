import { describe, expect, it } from 'vitest';
import { OUTPUT_BEGIN, OUTPUT_END } from '../../src/contracts.js';
import { competitors } from '../../src/config/competitors.config.js';
import { buildRewritePrompt, requiredLink } from '../../src/rewrite/rewrite-prompt.js';
import { BASE_URL, config, sampleFact, utmLink, validate } from '../fixtures/validation/helpers.js';

describe('buildRewritePrompt', () => {
  const text = `According to IMARC Group growth — fast. ${BASE_URL}`;
  const report = validate(text);
  const prompt = buildRewritePrompt({
    text,
    issues: report.issues.filter((i) => i.severity === 'hard_fail'),
    facts: [sampleFact],
    platform: 'x',
    config,
  });

  it('lists the exact failing issues', () => {
    expect(prompt).toContain('[COMPETITOR_MENTION]');
    expect(prompt).toContain('[BANNED_CHARACTER]');
    expect(prompt).toContain('[MISSING_UTM]');
  });

  it('does not echo competitor names in the instructions or issue details', () => {
    const instructions = prompt.slice(0, prompt.indexOf('CURRENT TEXT:'));
    for (const c of competitors) {
      for (const alias of [c.name, ...c.aliases]) expect(instructions.toLowerCase()).not.toContain(alias.toLowerCase());
    }
  });

  it('states the constraints: only listed fixes, no new numbers, exact link once, hard cap', () => {
    expect(prompt).toContain('Fix ONLY the problems listed');
    expect(prompt).toContain('Add NO new numbers');
    expect(prompt).toContain(`EXACTLY ONCE, character for character, with nothing added or removed: ${utmLink('x')}`);
    expect(prompt).toContain('HARD CAP: the final text must be at most 280 characters');
    expect(prompt).toContain('every URL counts as 23 characters');
  });

  it('lists the allowed facts by id and includes the output format instruction', () => {
    expect(prompt).toContain('[F1] market_size = 4.2 USD billion');
    expect(prompt).toContain(OUTPUT_BEGIN);
    expect(prompt).toContain(OUTPUT_END);
  });

  it('asks for a title on blogs and states the 2280 cap on facebook', () => {
    const blog = buildRewritePrompt({ text: 'x', issues: [{ code: 'MISSING_TITLE', severity: 'hard_fail', message: 'm' }], facts: [], platform: 'blog', config });
    expect(blog).toContain('markdown H1');
    const fb = buildRewritePrompt({ text: 'x', issues: [{ code: 'OVER_HARD_LIMIT', severity: 'hard_fail', message: 'm' }], facts: [], platform: 'facebook', config });
    expect(fb).toContain('at most 2280 characters');
    expect(fb).toContain('use no numbers at all');
  });

  it('resolves the required link from the explicit source URL or the text', () => {
    expect(requiredLink({ text: 'none', sourceUrl: BASE_URL, platform: 'linkedin', config })).toBe(utmLink('linkedin'));
    expect(requiredLink({ text: `see ${BASE_URL}`, platform: 'x', config })).toBe(utmLink('x'));
    expect(requiredLink({ text: 'no link', platform: 'x', config })).toBeNull();
  });
  it('keeps the selected LinkedIn narrative and single-question rule during validator repairs', () => {
    const p = buildRewritePrompt({ text: 'Draft.', issues: [], facts: [sampleFact], platform: 'linkedin', config, layout: 'short-narrative' });
    expect(p).toContain('Situation, tension, implication');
    expect(p).toContain('without bullets or numbered lists');
    expect(p).toContain('ONE discussion question after the link');
    expect(p).not.toContain('Keep BOTH questions');
    expect(p).not.toContain('Years (for example **2025**) are bold too');
  });

  it('adds extra notes when given', () => {
    const p = buildRewritePrompt({ text: 'x', issues: [{ code: 'PLACEHOLDER', severity: 'hard_fail', message: 'm' }], facts: [], platform: 'x', config, notes: ['Your previous reply was cut off.'] });
    expect(p).toContain('NOTES:');
    expect(p).toContain('cut off');
  });
});
