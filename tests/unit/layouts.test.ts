import { describe, expect, it } from 'vitest';
import { checkLayout } from '../../src/validation/checks/layout.js';
import { checkEmoji } from '../../src/validation/checks/hard-fail.js';
import { applyFixers } from '../../src/validation/index.js';
import { VariationHistory, layoutIdsFor, layoutSection, mulberry32, sampleVariant } from '../../src/strategy/index.js';
import { buildCheckContext } from '../../src/validation/checks/context.js';
import { MemoryStore } from '../../src/store/store.js';
import { codesOf, config, sampleFact } from '../fixtures/validation/helpers.js';

const TAIL = '\n\nWhich of these would change your plan?\n\nFor decision-makers evaluating this market, review the full market breakdown here:\nhttps://www.kenresearch.com/x\n\nWhere do you see the next feature?\n\n#KenResearch #Test';
const bullets = 'Ken Research sizes the market at USD 1 billion in 2025.\n\nThree things to note:\n\n- One point here.\n\n- Two point here.\n\n- Three point here.' + TAIL;
const myth = 'Myth: traffic is all that matters.\n\nReality: according to Ken Research the market is USD 1 billion.\n\nWhat the research points to:\n\n- One point here.\n\n- Two point here.\n\n- Three point here.' + TAIL;

const layoutCtx = (layout?: string) => ({ ...buildCheckContext('linkedin', config), ...(layout ? { layout } : {}) });
const codes = (text: string, layout?: string) => checkLayout(text, layoutCtx(layout)).map((i) => i.code);

describe('post layouts', () => {
  const oneQuestionTail = '\n\nReport:\nhttps://www.kenresearch.com/x\n\nWhich capability would you prioritize?\n\n#KenResearch #Test';
  const narrative = 'Hardware prices are changing how suppliers compete.\n\nKen Research sizes the market at USD 1 billion.\n\nSoftware and safety requirements shape the choice.\n\nThis gives buyers a concrete capability to evaluate.' + oneQuestionTail;
  it.each(['short-narrative', 'evidence-to-decision', 'stat-spotlight', 'forecast-timeline', 'two-lens-comparison', 'source-quote-analysis', 'market-watchlist'])('%s accepts paragraphs without forcing a list', (layout) => {
    expect(codes(narrative, layout)).toEqual([]);
    expect(codes(narrative.replace('Software and safety', '- Software and safety'), layout)).toContain('LIST_TOO_LONG');
  });
  it('enforces one question after the link and a concise hook, which may itself be one question', () => {
    expect(codes(narrative.replace('Hardware prices are changing how suppliers compete.', 'Why are hardware prices changing?'), 'short-narrative')).toEqual([]);
    expect(codes(narrative.replace('Hardware prices are changing how suppliers compete.', 'Why are prices changing? Who gains?'), 'short-narrative')).toContain('DISCUSSION_QUESTION_COUNT');
    expect(codes(narrative.replace('Report:\nhttps://www.kenresearch.com/x\n\nWhich capability would you prioritize?', 'Which capability would you prioritize?\n\nReport:\nhttps://www.kenresearch.com/x'), 'short-narrative')).toContain('DISCUSSION_QUESTION_POSITION');
    expect(codes(narrative.replace('Hardware prices are changing how suppliers compete.', 'word '.repeat(26)), 'short-narrative')).toContain('HOOK_TOO_LONG');
  });
  it.each(['facebook', 'linkedin'] as const)('%s ignores query punctuation in bare, labelled and markdown report links', (platform) => {
    const ctx = { ...buildCheckContext(platform, config), layout: 'short-narrative' };
    const url = 'https://www.kenresearch.com/x?utm_source=linkedin&utm_medium=referral&next=why?';
    for (const report of [url, `Report: ${url}`, `[Full report](${url})`]) {
      const text = narrative.replace('Report:\nhttps://www.kenresearch.com/x', report);
      expect(checkLayout(text, ctx)).toEqual([]);
      expect(checkLayout(text + '\nAnother question?', ctx).map((i) => i.code)).toContain('DISCUSSION_QUESTION_COUNT');
      expect(checkLayout(text.replace('Which capability would you prioritize?', 'Consider the capability fit.'), ctx).map((i) => i.code)).toContain('DISCUSSION_QUESTION_COUNT');
    }
    for (const report of [`Which capability matters?\nReport: ${url}`, `Which capability matters? Report: ${url}`]) {
      const text = narrative.replace('Report:\nhttps://www.kenresearch.com/x\n\nWhich capability would you prioritize?', report);
      expect(checkLayout(text, ctx).map((i) => i.code)).toContain('DISCUSSION_QUESTION_POSITION');
    }
  });
  it('offers country comparison only when source notes name enough countries', () => {
    expect(layoutIdsFor('linkedin', [])).not.toContain('country-contrast');
    expect(layoutIdsFor('linkedin', [{ text: 'Demand is growing across Southeast Asia.' }])).not.toContain('country-contrast');
    expect(layoutIdsFor('linkedin', [{ text: 'China has scale, India has localization opportunities, and Japan has safety requirements.' }])).toContain('country-contrast');
  });
  it('LinkedIn and Facebook share the same ten approved formats', () => {
    expect(layoutIdsFor('linkedin')).toEqual(['insight-brief', 'short-narrative', 'evidence-to-decision', 'country-contrast', 'stat-spotlight', 'forecast-timeline', 'two-lens-comparison', 'source-quote-analysis', 'evaluation-checklist', 'market-watchlist']);
    expect(layoutIdsFor('facebook')).toEqual(layoutIdsFor('linkedin'));
    expect(layoutIdsFor('facebook', [])).toEqual(layoutIdsFor('linkedin', []));
    expect(layoutIdsFor('x')).toEqual([]);
  });
  it.each(['facebook', 'linkedin'] as const)('%s screens source-dependent formats before sampling', (platform) => {
    const base = { ...sampleFact, marketDefinition: 'Widget Market' };
    const future = { ...base, id: 'F2', period: '2032', value: 8 };
    const empty = layoutIdsFor(platform, [], []);
    expect(empty).not.toContain('stat-spotlight');
    expect(empty).not.toContain('forecast-timeline');
    expect(empty).not.toContain('source-quote-analysis');
    expect(layoutIdsFor(platform, [], [{ ...base, verificationStatus: 'unverified' }])).not.toContain('stat-spotlight');
    expect(layoutIdsFor(platform, [], [base, future])).toContain('forecast-timeline');
    expect(layoutIdsFor(platform, [], [base])).toContain('stat-spotlight');
    for (const mismatch of [{ geography: 'Elsewhere' }, { marketDefinition: 'Other Market' }, { unit: 'USD million' }, { period: '2025' }, { verificationStatus: 'unverified' as const }]) {
      expect(layoutIdsFor(platform, [], [base, { ...future, ...mismatch }])).not.toContain('forecast-timeline');
    }
    expect(layoutIdsFor(platform, [], [sampleFact, { ...sampleFact, period: '2032' }])).not.toContain('forecast-timeline');
    const note = { text: 'India provides the fastest percentage-growth profile.', tier: 'ken_research' };
    expect(layoutIdsFor(platform, [note], [])).toContain('source-quote-analysis');
    expect(layoutIdsFor(platform, [{ ...note, tier: 'background' }], [])).not.toContain('source-quote-analysis');
  });
  it('the evaluation checklist requires exactly three list items', () => {
    const text = narrative.replace('Software and safety requirements shape the choice.', '- Hardware exposure.\n\n- Capability fit.\n\n- Market access.');
    expect(codes(text, 'evaluation-checklist')).toEqual([]);
    expect(codes(text.replace('\n\n- Market access.', ''), 'evaluation-checklist')).toContain('MISSING_LIST_STRUCTURE');
    expect(codes(text.replace('- Market access.', '- Market access.\n\n- Fourth consideration.'), 'evaluation-checklist')).toContain('LIST_TOO_LONG');
  });
  it.each(['facebook', 'linkedin'] as const)('%s uses the same narrative and single-question contract', (platform) => {
    const ctx = { ...buildCheckContext(platform, config), layout: 'short-narrative' };
    expect(checkLayout(narrative, ctx)).toEqual([]);
    expect(checkLayout(narrative + '\nAnother question?', ctx).map((i) => i.code)).toContain('DISCUSSION_QUESTION_COUNT');
    expect(layoutSection(config, platform, 'short-narrative')).toContain('ONE discussion question after the link');
  });

  it('bullet-insights accepts a statement opener and "- " bullets without a hook-question flag', () => {
    expect(codes(bullets, 'bullet-insights')).toEqual([]);
    expect(codes(bullets, 'numbered-points')).toContain('HOOK_NOT_QUESTION');
    expect(codes(bullets)).toContain('DISCUSSION_QUESTION_COUNT'); // old multi-question closing is no longer the LinkedIn default
  });

  it('myth-reality requires the Myth: and Reality: paragraphs', () => {
    expect(codes(myth, 'myth-reality')).toEqual([]);
    expect(codes(bullets, 'myth-reality')).toEqual(['MISSING_LIST_STRUCTURE']);
  });

  it('needs at least three bullets', () => {
    expect(codes('Ken Research says so.\n\n- One.\n\n- Two.' + TAIL, 'bullet-insights')).toContain('MISSING_LIST_STRUCTURE');
  });

  it('the prompt describes the chosen layout and bans emoji and em dashes', () => {
    const p = layoutSection(config, 'linkedin', 'myth-reality')!;
    expect(p).toContain('Layout for this post: Myth versus reality.');
    expect(p).toContain('"Myth:"');
    expect(p).toContain('No emoji or em dashes');
    expect(layoutSection(config, 'linkedin')).toContain('Insight and three takeaways');
  });

  it('the sampler cycles layouts for one report and drops the hook style for statement layouts', async () => {
    const history = await new VariationHistory(new MemoryStore()).load();
    const seen: Array<string | undefined> = [];
    for (let i = 0; i < layoutIdsFor('linkedin').length; i++) {
      const v = sampleVariant({ campaign: { id: 'authority-insights' }, itemId: 'i', personaId: 'pe-vc', platform: 'linkedin', history, rng: mulberry32(i), config, hookStyles: ['sufficiency', 'implication'], layouts: layoutIdsFor('linkedin') });
      await history.record(v, 'linkedin');
      seen.push(v.layout);
      if (v.layout !== 'numbered-points') expect(v.hookStyle).toBeUndefined();
      else expect(v.hookStyle).toBeDefined();
    }
    expect(new Set(seen).size).toBe(layoutIdsFor('linkedin').length);
  });
});

describe('emoji', () => {
  it('is a hard fail on every platform, and the fixer removes it', () => {
    expect(codesOf(checkEmoji, 'Market size 📊 USD 1 billion')).toEqual(['BANNED_EMOJI']);
    expect(codesOf(checkEmoji, 'Tick ✔ and arrow ➤', 'linkedin')).toEqual(['BANNED_EMOJI']);
    expect(codesOf(checkEmoji, 'Plain text, an arrow → and ©, ®, ™ are fine.')).toEqual([]);
    const fixed = applyFixers('Growth 📈 is steady https://www.kenresearch.com/x', { platform: 'x', config });
    expect(fixed.text).not.toMatch(/📈/u);
    expect(fixed.applied.map((a) => a.id)).toContain('STRIP_EMOJI');
  });
});

describe('output marker cleanup', () => {
  it('strips malformed format markers from a salvaged reply', async () => {
    const { salvagePlainText } = await import('../../src/contracts.js');
    expect(salvagePlainText('<<<CE_OUTPUT>>\n\nWhy did it grow?\n\n1. A point.')).toBe('Why did it grow?\n\n1. A point.');
    expect(salvagePlainText('Why did it grow?\n<<<CE_END>>>>')).toBe('Why did it grow?');
  });
});
