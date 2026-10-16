import { describe, expect, it } from 'vitest';
import { competitors } from '../../src/config/competitors.config.js';
import { loadConfig } from '../../src/config/index.js';
import { personas } from '../../src/config/persona.config.js';
import { OUTPUT_BEGIN, OUTPUT_END, TEXT_MARKER } from '../../src/contracts.js';
import type { ContentVariant, PlatformId } from '../../src/schemas/index.js';
import { MemoryStore } from '../../src/store/store.js';
import {
  buildDraftPrompt,
  buildEditorialRewritePrompt,
  buildOutlinePrompt,
  buildResearchBriefPrompt,
  discussionQuestionSection,
  type PromptContext,
} from '../../src/strategy/prompts/index.js';
import { VariationHistory, mulberry32, sampleVariant } from '../../src/strategy/variation.js';
import { normalizeForMatch } from '../../src/utils/normalize.js';
import { applyUtm } from '../../src/utils/utm.js';
import { loadFacts } from '../fixtures/strategy/load.js';

const config = loadConfig();
const allFacts = loadFacts();
const passed = allFacts.slice(0, 2); // F1, F2
const reportUrl = 'https://www.kenresearch.com/examplestan-widget-market';
const persona = personas.find((p) => p.id === 'pe-vc')!;
const brief = {
  angle: 'What the market size means for investors',
  keywords: ['widget market'],
  beatPoints: ['Add a dedicated section on pricing, a topic comparable outlines cover and ours currently lacks.'],
};

function ctx(platform: PlatformId): PromptContext {
  return { config, platform, persona, tone: 'data-led', facts: passed, reportUrl };
}

function variantFor(platform: PlatformId): ContentVariant {
  const history = new VariationHistory(new MemoryStore());
  return sampleVariant({ campaign: { id: 'authority-insights' }, itemId: 'i1', personaId: 'pe-vc', platform, history, rng: mulberry32(1), config });
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const stages = (platform: PlatformId) => ({
  'research-brief': buildResearchBriefPrompt({ ...ctx(platform), brief }),
  outline: buildOutlinePrompt({ ...ctx(platform), brief }),
  draft: buildDraftPrompt({ ...ctx(platform), brief, variant: variantFor(platform) }),
  'editorial-rewrite': buildEditorialRewritePrompt({ ...ctx(platform), draftText: 'A short draft about the market.', issues: ['Too many adjectives'] }),
});

describe('prompt templates', () => {
  it('include every required section and the output format', () => {
    for (const [stage, built] of Object.entries(stages('linkedin'))) {
      const p = built.prompt;
      for (const h of ['WRITER', 'TONE FOR THIS PIECE', 'STYLE RULES', 'SOURCE RULE', 'FACTS', 'PLATFORM LIMITS', 'SOURCE LINK', 'OUTPUT FORMAT']) {
        expect(p, `${stage} missing ${h}`).toContain(`## ${h}`);
      }
      expect(p).toContain(OUTPUT_BEGIN);
      expect(p).toContain(OUTPUT_END);
      expect(p).toContain(TEXT_MARKER);
      expect(p).toContain('FACT_IDS');
      expect(p).toContain(persona.label);
      expect(p).toContain('data-led');
      for (const b of config.brand.bannedPhrases) expect(p).toContain(b);
      for (const w of config.brand.bannedPromoWords) expect(p).toContain(w);
      expect(p).toContain('Never use these characters');
    }
  });

  it('stamps the per-stage prompt version from config', () => {
    const s = stages('x');
    expect(s['research-brief'].promptVersion).toBe(config.prompts.prompts['research-brief']);
    expect(s.outline.promptVersion).toBe(config.prompts.prompts.outline);
    expect(s.draft.promptVersion).toBe(config.prompts.prompts.draft);
    expect(s['editorial-rewrite'].promptVersion).toBe(config.prompts.prompts['editorial-rewrite']);
  });

  it('draft prompt adds opener, structure, length and CTA instructions', () => {
    const p = stages('x').draft.prompt;
    expect(p).toContain('## VARIATION AXES FOR THIS DRAFT');
    expect(p).toContain('Opener (');
    expect(p).toContain('Structure (');
    expect(p).toContain('Length class (');
    expect(p).toContain('Call to action:');
    expect(p).not.toContain('POST LAYOUT');
  });
  it('injects only the selected LinkedIn format and excludes bulky legacy examples and technique lists', () => {
    const prompt = buildDraftPrompt({ ...ctx('linkedin'), layout: 'short-narrative', brief,
      variant: variantFor('linkedin'), styleExamples: ['OLD FIVE POINT TEMPLATE '.repeat(100)],
      techniques: ['DUPLICATE REPO GUIDANCE'], hook: { instruction: 'LEGACY QUESTION HOOK' },
    }).prompt;
    expect(prompt).toContain('Situation, tension, implication');
    expect(prompt).not.toContain('Insight and three takeaways');
    expect(prompt).not.toContain('OLD FIVE POINT TEMPLATE');
    expect(prompt).not.toContain('DUPLICATE REPO GUIDANCE');
    expect(prompt).not.toContain('LEGACY QUESTION HOOK');
    expect(prompt).toContain('ONE discussion question after the link');
    expect(prompt.split(/\s+/).length).toBeLessThan(900);
  });
  it('varies one answerable reader invitation without changing the approved format or forcing an X question', () => {
    const directions = new Set(Array.from({ length: 32 }, (_, i) => discussionQuestionSection('linkedin', `report-${i}`)));
    expect(directions.size).toBe(4);
    expect(discussionQuestionSection('linkedin', 'same')).toBe(discussionQuestionSection('facebook', 'same'));
    expect(discussionQuestionSection('x', 'same')).toBeNull();
    const p = stages('linkedin').draft.prompt;
    expect(p).toContain('## DISCUSSION QUESTION');
    expect(p).toContain('Avoid a generic ranking of the bullets');
    expect(p).toContain('first evidence sentence');
    expect(p).toContain('a hashtag or report-link label alone does not count');
    expect(stages('x').draft.prompt).not.toContain('## DISCUSSION QUESTION');
  });

  it.each(['facebook', 'linkedin'] as const)('%s draft prompt carries the fixed numbered-points layout instead of an opener/structure choice', (platform) => {
    const p = stages(platform).draft.prompt;
    expect(p).toContain('## POST LAYOUT (follow exactly)');
    expect(p).toContain('Insight and three takeaways');
    expect(p).toContain('#KenResearch');
    expect(p).toContain('Structure: follow the POST LAYOUT above exactly.');
    expect(p).not.toContain('Structure (');
    expect(p).toContain('Length class (');
  });

  it('never names a competitor firm in any stage on any platform', () => {
    const names = competitors.flatMap((c) => [c.name, ...c.aliases, ...c.literals]);
    for (const platform of ['x', 'facebook', 'linkedin', 'blog'] as const) {
      for (const [stage, built] of Object.entries(stages(platform))) {
        const lower = built.prompt.toLowerCase();
        const norm = ` ${normalizeForMatch(built.prompt)} `;
        for (const n of names) {
          expect(lower.includes(n.toLowerCase()), `${stage}/${platform} contains "${n}"`).toBe(false);
          const alias = normalizeForMatch(n);
          if (alias) expect(norm.includes(` ${alias} `), `${stage}/${platform} contains alias "${alias}"`).toBe(false);
        }
        for (const c of competitors) for (const d of c.domains) expect(lower).not.toContain(d);
      }
    }
  });

  it('contains only the facts passed in', () => {
    const outside = allFacts[2]!; // F3
    for (const built of Object.values(stages('linkedin'))) {
      const p = built.prompt;
      expect(p).toContain('[F1]');
      expect(p).toContain('[F2]');
      expect(p).toContain('12.4 USD billion');
      for (const f of allFacts.slice(2)) {
        expect(p).not.toContain(`[${f.id}]`);
        expect(p).not.toContain(String(f.value));
      }
      expect(p).not.toContain(String(outside.value));
    }
  });

  it('says so when no facts are passed', () => {
    const p = buildDraftPrompt({ ...ctx('x'), facts: [], brief, variant: variantFor('x') }).prompt;
    expect(p).toContain('No facts are provided');
    expect(p).not.toContain('[F1]');
  });

  it('contains the UTM link exactly once in every stage', () => {
    for (const platform of ['x', 'facebook', 'linkedin', 'blog'] as const) {
      const link = applyUtm(reportUrl, config.utm[platform]!);
      for (const [stage, built] of Object.entries(stages(platform))) {
        expect(count(built.prompt, link), `${stage}/${platform} link count`).toBe(1);
        expect(count(built.prompt, reportUrl), `${stage}/${platform} raw url count`).toBe(1);
      }
    }
  });

  it('rewrite keeps the link once when the draft already carries it', () => {
    const link = applyUtm(reportUrl, config.utm.linkedin!);
    const built = buildEditorialRewritePrompt({ ...ctx('linkedin'), draftText: `Body text. ${link}`, issues: [] });
    expect(count(built.prompt, link)).toBe(1);
    expect(built.prompt).toContain('already contains the source link');
  });

  it('states the 2280 cap for facebook and linkedin in every stage', () => {
    for (const platform of ['facebook', 'linkedin'] as const) {
      for (const [stage, built] of Object.entries(stages(platform))) {
        expect(built.prompt, `${stage}/${platform}`).toContain('Hard cap: 2280 characters');
      }
    }
  });

  it('does not carry planning-signal text into prompts', () => {
    const sneaky = { ...brief, planningSignals: [{ title: 'Secret Signal Title', sourceUrl: 'https://leader.example.org/x' }] };
    const p = buildDraftPrompt({ ...ctx('x'), brief: sneaky, variant: variantFor('x') }).prompt;
    expect(p).not.toContain('Secret Signal Title');
    expect(p).not.toContain('leader.example.org');
  });

  it('cites-only rule is generic', () => {
    const p = stages('x').draft.prompt;
    expect(p).toMatch(/Cite only Ken Research and official government or regulatory bodies/);
  });
});
