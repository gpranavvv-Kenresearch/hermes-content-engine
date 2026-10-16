import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { ContentVariantSchema, PlatformIdSchema, type ContentVariant, type PlatformId } from '../../src/schemas/index.js';
import { MemoryStore } from '../../src/store/store.js';
import {
  CTA_PLACEMENTS,
  NUMBERED_LAYOUT_PLATFORMS,
  TONES,
  ctaVariantsFor,
  lengthClassesFor,
  structuresFor,
} from '../../src/strategy/variation-axes.js';
import {
  VariationHistory,
  checkVariantSet,
  diversityReport,
  mulberry32,
  sampleVariant,
  seedFromString,
} from '../../src/strategy/variation.js';

const config = loadConfig();
const campaign = { id: 'authority-insights' };

async function run(history: VariationHistory, itemId: string, platform: PlatformId, count: number, seed: number, extra: Partial<Parameters<typeof sampleVariant>[0]> = {}) {
  const rng = mulberry32(seed);
  const out: ContentVariant[] = [];
  for (let i = 0; i < count; i++) {
    const v = sampleVariant({ campaign, itemId, personaId: 'pe-vc', platform, history, rng, config, ...extra });
    await history.record(v, platform, new Date('2026-10-13T00:00:00Z'));
    out.push(v);
  }
  return out;
}

describe('rng', () => {
  it('mulberry32 is deterministic and in [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(xs).toEqual(Array.from({ length: 5 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(43)()).not.toBe(xs[0]);
  });
  it('seedFromString is stable', () => {
    expect(seedFromString('item-1')).toBe(seedFromString('item-1'));
    expect(seedFromString('item-1')).not.toBe(seedFromString('item-2'));
  });
});

describe('axis tables', () => {
  it('length classes never exceed hard caps or target bands', () => {
    for (const p of PlatformIdSchema.options) {
      const limit = config.platformLimits[p];
      for (const c of lengthClassesFor(p, limit)) {
        expect(c.minChars).toBeLessThanOrEqual(c.maxChars);
        if (limit.hardMaxChars !== null) expect(c.maxChars).toBeLessThanOrEqual(limit.hardMaxChars);
        if (limit.targetMaxChars !== null) expect(c.maxChars).toBeLessThanOrEqual(limit.targetMaxChars);
        if (limit.targetMinChars !== null) expect(c.minChars).toBeGreaterThanOrEqual(limit.targetMinChars);
      }
    }
    expect(Math.max(...lengthClassesFor('facebook', config.platformLimits.facebook).map((c) => c.maxChars))).toBeLessThanOrEqual(2280);
  });

  it('offers source-safe X structures, broad long-form choices and diverse tones', () => {
    for (const p of PlatformIdSchema.options) {
      if (NUMBERED_LAYOUT_PLATFORMS.includes(p)) continue;
      expect(structuresFor(p).length).toBeGreaterThanOrEqual(p === 'x' || p === 'tumblr' ? 4 : 5);
    }
    expect(TONES.length).toBeGreaterThanOrEqual(8);
  });

  it('platforms with the fixed numbered-points layout have exactly that structure, in step with the config', () => {
    const fromConfig = PlatformIdSchema.options.filter((p) => config.platformLimits[p].formatting.layout === 'numbered_points');
    expect([...NUMBERED_LAYOUT_PLATFORMS].sort()).toEqual([...fromConfig].sort());
    for (const p of NUMBERED_LAYOUT_PLATFORMS) expect(structuresFor(p).map((s) => s.id)).toEqual(['numbered-points']);
  });

  it('CTA variants derive from brand attribution phrases and keep the single-link rule', () => {
    const ctas = ctaVariantsFor(config.brand);
    expect(ctas).toHaveLength(config.brand.attributionPhrases.length * CTA_PLACEMENTS.length);
    for (const c of ctas) {
      expect(config.brand.attributionPhrases).toContain(c.attributionPhrase);
      expect(c.instruction).toContain('exactly once');
    }
    expect(new Set(ctas.map((c) => c.id)).size).toBe(ctas.length);
  });
});

describe('sampleVariant', () => {
  it('five variants for one item are pairwise distinct on tone and structure', async () => {
    const history = await new VariationHistory(new MemoryStore()).load();
    const vs = await run(history, 'item-1', 'linkedin', 5, 7);
    for (const v of vs) expect(ContentVariantSchema.safeParse(v).success).toBe(true);
    expect(new Set(vs.map((v) => v.tone)).size).toBe(5);
    // LinkedIn has one fixed layout (numbered points), so variety comes from tone and opener
    expect(new Set(vs.map((v) => v.structure))).toEqual(new Set(['numbered-points']));
    expect(new Set(vs.map((v) => v.opener)).size).toBe(5);
  });

  it('cycles through source-safe X structures before reusing one', async () => {
    const history = await new VariationHistory(new MemoryStore()).load();
    const vs = await run(history, 'item-x', 'x', 5, 11);
    expect(new Set(vs.map((v) => v.tone)).size).toBe(5);
    expect(new Set(vs.map((v) => v.structure)).size).toBe(structuresFor('x').length);
    expect(vs.every(v => !['myth-reality', 'question-answer'].includes(v.structure))).toBe(true);
    expect(new Set(vs.slice(0, 4).map(v => v.structure)).size).toBe(4);
  });

  it('is deterministic for a fixed seed and history', async () => {
    const a = await run(await new VariationHistory(new MemoryStore()).load(), 'item-1', 'facebook', 4, 99);
    const b = await run(await new VariationHistory(new MemoryStore()).load(), 'item-1', 'facebook', 4, 99);
    expect(a).toEqual(b);
    const c = await run(await new VariationHistory(new MemoryStore()).load(), 'item-1', 'facebook', 4, 100);
    expect(c).not.toEqual(a);
  });

  it('avoids combinations already in persisted history, across a reload', async () => {
    const store = new MemoryStore();
    const first = await run(await new VariationHistory(store).load(), 'item-1', 'linkedin', 3, 5);
    const reloaded = await new VariationHistory(store).load();
    expect(reloaded.forItem('item-1')).toHaveLength(3);
    const next = sampleVariant({ campaign, itemId: 'item-1', personaId: 'pe-vc', platform: 'linkedin', history: reloaded, rng: mulberry32(5), config });
    expect(first.map((v) => v.tone)).not.toContain(next.tone);
    expect(first.map((v) => v.opener)).not.toContain(next.opener);
  });

  it('exhausting tones cycles instead of failing', async () => {
    const history = await new VariationHistory(new MemoryStore()).load();
    const vs = await run(history, 'item-1', 'blog', TONES.length + 2, 3);
    expect(vs).toHaveLength(TONES.length + 2);
    expect(new Set(vs.slice(0, TONES.length).map((v) => v.tone)).size).toBe(TONES.length);
  });

  it('keeps campaign-level tone share under the cap across many items', async () => {
    const history = await new VariationHistory(new MemoryStore()).load();
    const all: ContentVariant[] = [];
    for (let i = 0; i < 20; i++) all.push(...(await run(history, `item-${i}`, 'x', 1, 1000 + i, { maxToneShare: 0.3, window: 20 })));
    const counts = new Map<string, number>();
    for (const v of all) counts.set(v.tone, (counts.get(v.tone) ?? 0) + 1);
    expect(Math.max(...counts.values()) / all.length).toBeLessThanOrEqual(0.3);
  });

  it('uses the configured draft prompt version', async () => {
    const history = await new VariationHistory(new MemoryStore()).load();
    const [v] = await run(history, 'item-1', 'x', 1, 1);
    expect(v!.promptVersion).toBe(config.prompts.prompts.draft);
  });
});

describe('diversityReport', () => {
  it('reports shares and warns when one tone dominates', () => {
    const base = { campaignId: 'c', itemId: 'i', personaId: 'p', opener: 'o', structure: 's', lengthClass: 'l', ctaVariant: 'c', promptVersion: 'v' };
    const variants: ContentVariant[] = [
      ...Array.from({ length: 4 }, () => ({ ...base, tone: 'urgent' })),
      { ...base, tone: 'analytical' },
    ];
    const r = diversityReport(variants);
    expect(r.total).toBe(5);
    expect(r.axes.tone[0]).toMatchObject({ id: 'urgent', count: 4 });
    expect(r.warnings.some((w) => w.includes('tone "urgent"'))).toBe(true);
    expect(r.repeatedCombos).toBe(1);
  });
});

describe('checkVariantSet', () => {
  const a = 'Examplestan widget makers face a pricing squeeze as input costs climb and buyers consolidate orders across regions this year.';
  const distinct = 'Investors screening Examplestan should weigh segment concentration first, because one product line carries most of the volume today.';

  it('flags near-duplicate variants of the same item', () => {
    const r = checkVariantSet([a, a.replace('this year', 'this season'), distinct], { threshold: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.flagged.map((p) => [p.a, p.b])).toEqual([[0, 1]]);
  });

  it('passes genuinely different texts', () => {
    const r = checkVariantSet([a, distinct]);
    expect(r.ok).toBe(true);
    expect(r.maxScore).toBeLessThan(0.5);
  });
});
