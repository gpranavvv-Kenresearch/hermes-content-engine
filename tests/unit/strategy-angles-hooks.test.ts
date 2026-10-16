import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import type { SourceNote } from '../../src/schemas/index.js';
import { MemoryStore } from '../../src/store/store.js';
import {
  ANGLES,
  HOOK_STYLES,
  NUMBERS_FIRST,
  VariationHistory,
  angleById,
  availableAngles,
  buildDraftPrompt,
  groupNotesByAngle,
  loadStyleExamples,
  mulberry32,
  primaryNotesFor,
  sampleVariant,
} from '../../src/strategy/index.js';
import { sampleFact } from '../fixtures/validation/helpers.js';

const config = loadConfig();
const campaign = { id: 'authority-insights' };

// Real notes taken from the South Africa report page (see docs/strategy.md).
const NOTES: SourceNote[] = [
  { id: 'N1', sourceUrl: 'https://www.kenresearch.com/x', text: 'Growth will be supported by higher employer adoption of digital recruitment, expanding dealer and agency subscriptions and greater mobile engagement.' },
  { id: 'N2', sourceUrl: 'https://www.kenresearch.com/x', text: 'Competitive remedies should improve access for smaller agencies and dealers, although leading portals will retain advantages in traffic, inventory and proprietary matching data.' },
  { id: 'N3', sourceUrl: 'https://www.kenresearch.com/x', text: 'Job portals should gain revenue share where employers adopt performance-linked recruitment packages, while automotive and property portals remain the largest sources of recurring account revenue.' },
  { id: 'N4', sourceUrl: 'https://www.kenresearch.com/x', text: 'Identity, employer, dealership and agency verification can be sold through premium subscriptions, per-check charges and trust badges.' },
  { id: 'N5', sourceUrl: 'https://www.kenresearch.com/x', text: 'The market is concentrated in automotive and property classifieds but more fragmented in recruitment.' },
];

describe('angles', () => {
  it('groups notes by theme, a note may belong to several, and numbers-first needs none', () => {
    const groups = groupNotesByAngle(NOTES);
    expect(groups.get('growth-drivers')?.map((n) => n.id)).toContain('N1');
    expect(groups.get('competitive-structure')?.map((n) => n.id)).toEqual(expect.arrayContaining(['N2', 'N5']));
    expect(groups.get('monetization-pricing')?.map((n) => n.id)).toEqual(expect.arrayContaining(['N3', 'N4']));
    expect(groups.get('trust-verification')?.map((n) => n.id)).toContain('N4');
    expect(groups.has(NUMBERS_FIRST)).toBe(false);
  });

  it('offers only angles the report can back, plus numbers-first', () => {
    const ids = availableAngles(NOTES);
    expect(ids).toContain(NUMBERS_FIRST);
    expect(ids).toContain('growth-drivers');
    expect(ids).toContain('compliance'); // N2 mentions competition remedies
    // one note about market structure supports only that angle, plus numbers-first
    expect(availableAngles([NOTES[4]!])).toEqual(['competitive-structure', NUMBERS_FIRST]);
    expect(availableAngles([])).toEqual([NUMBERS_FIRST]);
  });

  it('gives the notes an angle should lead with, and none for numbers-first', () => {
    expect(primaryNotesFor('trust-verification', NOTES).map((n) => n.id)).toEqual(['N4']);
    expect(primaryNotesFor(NUMBERS_FIRST, NOTES)).toEqual([]);
  });

  it('every angle and hook has an id, an instruction and is unique', () => {
    expect(new Set(ANGLES.map((a) => a.id)).size).toBe(ANGLES.length);
    expect(new Set(HOOK_STYLES.map((h) => h.id)).size).toBe(HOOK_STYLES.length);
    for (const h of HOOK_STYLES) expect(h.instruction).toMatch(/question|Why|Is|What|Which|How/i);
    expect(angleById('growth-drivers')?.label).toBeTruthy();
  });
});

describe('angle and hook variation', () => {
  const angles = availableAngles(NOTES);
  const hookStyles = HOOK_STYLES.map((h) => h.id);

  async function run(n: number, seed: number, item = 'item-1', store = new MemoryStore()) {
    const history = await new VariationHistory(store).load();
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = sampleVariant({ campaign, itemId: item, personaId: 'pe-vc', platform: 'linkedin', history, rng: mulberry32(seed + i), config, angles, hookStyles });
      await history.record(v, 'linkedin');
      out.push(v);
    }
    return out;
  }

  it('gives five variants of one report five different angles AND five different hook formulas', async () => {
    const vs = await run(5, 21);
    expect(new Set(vs.map((v) => v.angle)).size).toBe(5);
    expect(new Set(vs.map((v) => v.hookStyle)).size).toBe(5);
    expect(new Set(vs.map((v) => v.tone)).size).toBe(5);
  });

  it('cycles instead of failing once every angle has been used', async () => {
    const vs = await run(angles.length + 2, 5);
    expect(vs).toHaveLength(angles.length + 2);
    expect(new Set(vs.slice(0, angles.length).map((v) => v.angle)).size).toBe(angles.length);
  });

  it('is deterministic, and remembers across a reload', async () => {
    expect(await run(3, 9)).toEqual(await run(3, 9));
    const store = new MemoryStore();
    const first = await run(2, 3, 'item-9', store);
    const reloaded = await new VariationHistory(store).load();
    const next = sampleVariant({ campaign, itemId: 'item-9', personaId: 'pe-vc', platform: 'linkedin', history: reloaded, rng: mulberry32(77), config, angles, hookStyles });
    expect(first.map((v) => v.angle)).not.toContain(next.angle);
    expect(first.map((v) => v.hookStyle)).not.toContain(next.hookStyle);
  });

  it('does not change the other axes for a given seed (angle and hook are drawn last)', async () => {
    const history = await new VariationHistory(new MemoryStore()).load();
    const plain = sampleVariant({ campaign, itemId: 'i', personaId: 'pe-vc', platform: 'facebook', history, rng: mulberry32(1234), config });
    const withAxes = sampleVariant({ campaign, itemId: 'i', personaId: 'pe-vc', platform: 'facebook', history, rng: mulberry32(1234), config, angles, hookStyles });
    const { angle, hookStyle, ...rest } = withAxes;
    expect(angle).toBeTruthy();
    expect(hookStyle).toBeTruthy();
    expect(rest).toEqual(plain);
  });

  it('leaves angle and hook out when none are offered', async () => {
    const history = await new VariationHistory(new MemoryStore()).load();
    const v = sampleVariant({ campaign, itemId: 'i', personaId: 'pe-vc', platform: 'x', history, rng: mulberry32(1), config });
    expect(v.angle).toBeUndefined();
    expect(v.hookStyle).toBeUndefined();
  });
});

describe('prompts carry angle, hook and style examples', () => {
  const persona = config.personas.find((p) => p.id === 'pe-vc')!;
  const build = async (extra: Record<string, unknown> = {}, platform: 'linkedin' | 'x' = 'linkedin') => {
    const history = await new VariationHistory(new MemoryStore()).load();
    const variant = sampleVariant({ campaign, itemId: 'i', personaId: persona.id, platform, history, rng: mulberry32(2), config });
    return buildDraftPrompt({
      config,
      platform,
      persona,
      tone: variant.tone,
      facts: [sampleFact],
      notes: NOTES,
      reportUrl: 'https://www.kenresearch.com/industry-reports/examplestan-widget-market',
      brief: { angle: 'a', keywords: [], beatPoints: [] },
      variant,
      ...extra,
    } as never).prompt;
  };

  it('keeps the supported angle without injecting a question-hook formula into LinkedIn', async () => {
    const angle = angleById('trust-verification')!;
    const p = await build({ angle: { label: angle.label, instruction: angle.instruction, primaryNotes: primaryNotesFor(angle.id, NOTES) }, hook: HOOK_STYLES[0] });
    expect(p).toContain('## ANGLE FOR THIS POST');
    expect(p).toContain('Trust and verification as a product');
    expect(p).toContain('mainly from these source notes: [N4]');
    expect(p).not.toContain('## HOOK STYLE');
    expect(p).toContain('short non-question lead');
  });

  it('omits both sections when not given, so older callers are unchanged', async () => {
    const p = await build();
    expect(p).not.toContain('## ANGLE FOR THIS POST');
    expect(p).not.toContain('## HOOK STYLE');
    expect(p).not.toContain('STYLE EXAMPLES');
  });

  it('shows curated posts as style-only examples on other platforms and forbids copying them', async () => {
    const p = await build({ styleExamples: ['Why did the market reach a figure that contrasts with the competition?\n\n1. A point.'] }, 'x');
    expect(p).toContain('## STYLE EXAMPLES (curated posts, for style only)');
    expect(p).toContain('NEVER copy their wording, names, facts or figures');
    expect(p).toContain('Example 1:');
  });
});

describe('style library', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ce-style-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const long = 'Why did the market reach this level and what does it mean for decision makers weighing entry?\n\n1. A point about growth that is long enough to count as a real example post.';

  it('reads .txt files, flattens bold and spacer characters, and hides links', () => {
    writeFileSync(path.join(dir, 'a.txt'), `${long}\n⠀\n𝐊𝐞𝐧 𝐑𝐞𝐬𝐞𝐚𝐫𝐜𝐡 reports 𝟕.𝟐%.\nhttps://lnkd.in/abc\n#Tag`, 'utf8');
    writeFileSync(path.join(dir, 'b.md'), 'ignored because it is not .txt', 'utf8');
    writeFileSync(path.join(dir, 'c.txt'), 'too short', 'utf8');
    const lib = loadStyleExamples(dir);
    expect(lib.files).toEqual(['a.txt']);
    expect(lib.examples).toHaveLength(1);
    expect(lib.examples[0]).toContain('Ken Research reports 7.2%.');
    expect(lib.examples[0]).toContain('[source link]');
    expect(lib.examples[0]).not.toMatch(/https?:|⠀|[\u{1D400}-\u{1D7FF}]/u);
  });

  it('honours max and returns nothing for a missing folder', () => {
    for (const n of ['d', 'e', 'f']) writeFileSync(path.join(dir, `${n}.txt`), long, 'utf8');
    expect(loadStyleExamples(dir, { max: 2 }).examples).toHaveLength(2);
    expect(loadStyleExamples(path.join(dir, 'nope')).examples).toEqual([]);
  });

  it('cuts long posts at a paragraph boundary', () => {
    const body = Array.from({ length: 12 }, (_, i) => `${i + 1}. ${'word '.repeat(40)}`).join('\n\n');
    writeFileSync(path.join(dir, 'g.txt'), body, 'utf8');
    const lib = loadStyleExamples(dir, { max: 20, maxChars: 500 });
    const g = lib.examples.find((e) => e.startsWith('1. word'));
    expect(g!.length).toBeLessThanOrEqual(500);
    expect(g!.endsWith('word')).toBe(true);
  });
});
