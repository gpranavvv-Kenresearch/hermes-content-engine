import { describe, expect, it } from 'vitest';
import { factsSection } from '../../src/strategy/prompts/common.js';
import { buildRewritePrompt } from '../../src/rewrite/rewrite-prompt.js';
import { checkNarrativeClaims } from '../../src/validation/narrative-claims.js';
import { config, sampleFact } from '../fixtures/validation/helpers.js';

const notes = [
  'Growth will be supported by higher employer adoption of digital recruitment, expanding dealer and agency subscriptions and greater mobile engagement.',
  'Competitive remedies should improve access for smaller agencies and dealers, although leading portals will retain advantages in traffic.',
];
const codes = (text: string, withNotes = true) => checkNarrativeClaims(text, [sampleFact], withNotes ? notes : []).map((i) => i.code);

describe('narrative check with source notes', () => {
  it('flags an invented driver, but accepts one the notes state', () => {
    const text = 'Growth is driven by higher employer adoption of digital recruitment.';
    expect(codes(text, false)).toContain('UNSUPPORTED_NARRATIVE_CLAIM');
    // the connector "driven by" is not in the notes, but "supported by" is the notes' wording: a connector must appear in the notes
    expect(codes('Growth will be supported by higher employer adoption of digital recruitment.')).toEqual([]);
  });

  it('accepts a driver that restates a note in other words (driven by vs supported by)', () => {
    expect(codes('Growth is driven by higher employer adoption of digital recruitment and expanded dealer subscriptions.')).toEqual([]);
    // but the same connector with content the notes do not contain is still flagged
    expect(codes('Growth is driven by tariff cuts and lower import duties.')).toContain('UNSUPPORTED_NARRATIVE_CLAIM');
    expect(codes('Growth is driven by satellite launches over the continent.')).toContain('UNSUPPORTED_NARRATIVE_CLAIM');
  });

  it('does not treat a question as a claim, but still flags the same words in a statement', () => {
    expect(codes('Which vertical do you see as having higher barriers to entry?')).toEqual([]);
    expect(codes('Barriers to entry are higher in property.')).toContain('UNSUPPORTED_NARRATIVE_CLAIM');
  });

  it('still flags policy terms and comparisons the notes do not contain', () => {
    expect(codes('Tariff cuts will lift the market.')).toContain('UNSUPPORTED_NARRATIVE_CLAIM');
    expect(codes('The market is growing faster than the industry average.')).toContain('UNSUPPORTED_NARRATIVE_CLAIM');
  });

  it('runs even when there are notes but no facts', () => {
    expect(checkNarrativeClaims('Tariff cuts will lift the market.', [], notes).map((i) => i.code)).toContain('UNSUPPORTED_NARRATIVE_CLAIM');
    expect(checkNarrativeClaims('Tariff cuts will lift the market.', [], [])).toEqual([]);
  });
});

describe('attribution to Ken Research', () => {
  it.each([
    'Ken Research positions this as a mature opportunity.',
    'Ken Research recommends early entry.',
    'Ken Research believes the window is closing.',
    'Ken Research analysis suggests a steady path.',
  ])('flags "%s" when no fact or note states that view', (text) => {
    expect(codes(text)).toContain('UNSUPPORTED_ATTRIBUTION');
  });

  it('accepts neutral reporting and a view that a note really states', () => {
    expect(codes('Ken Research finds the market valued at USD 4.2 billion in 2025.')).toEqual([]);
    expect(codes('Ken Research reports that growth continues.')).toEqual([]);
    const noted = checkNarrativeClaims('Ken Research expects higher adoption.', [sampleFact], ['Ken Research expects higher adoption of digital tools.']);
    expect(noted.map((i) => i.code)).not.toContain('UNSUPPORTED_ATTRIBUTION');
  });
});

describe('prompts carry the notes', () => {
  it('adds a SOURCE NOTES block only when notes exist, with the attribution rule', () => {
    const none = factsSection([sampleFact]);
    expect(none).not.toContain('SOURCE NOTES');
    const withNotes = factsSection([sampleFact], [{ id: 'N1', text: notes[0]! }]);
    expect(withNotes).toContain('## SOURCE NOTES (from the Ken Research report page)');
    expect(withNotes).toContain('- [N1] Growth will be supported');
    expect(withNotes).toContain('Never attribute your own interpretation');
  });

  it('the rewrite prompt lists the notes too', () => {
    const p = buildRewritePrompt({
      text: 'x',
      issues: [],
      facts: [sampleFact],
      platform: 'linkedin',
      config,
      sourceNotes: [{ id: 'N2', text: notes[1]! }],
    });
    expect(p).toContain('SOURCE NOTES');
    expect(p).toContain('[N2] Competitive remedies');
  });
});
