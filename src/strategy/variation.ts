import {
  ContentVariantSchema,
  type Campaign,
  type ContentVariant,
  type PlatformId,
} from '../schemas/index.js';
import type { Store } from '../store/store.js';
import { shortHash } from '../utils/hash.js';
import { textSimilarity } from '../utils/similarity.js';
import { defaultConfig, type LoadedConfig } from './context.js';
import { layoutById } from './layouts.js';
import {
  OPENERS,
  PERSONA_TONE_WEIGHTS,
  TONES,
  ctaVariantsFor,
  lengthClassesFor,
  structuresFor,
} from './variation-axes.js';

/** Variation engine: tone x opener x structure x length x CTA, sampled with a seeded RNG. */

export type Rng = () => number;

/** Small, fast, deterministic 32-bit PRNG. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable seed from any string (e.g. itemId + platform + run date). */
export function seedFromString(s: string): number {
  return parseInt(shortHash(s, 8), 16) >>> 0;
}

// --- history ----------------------------------------------------------------

export const VARIANTS_COLLECTION = 'variants';

export interface VariantRecord {
  seq: number;
  at: string;
  platform: PlatformId;
  variant: ContentVariant;
}

/** Read-only view the sampler needs. Synchronous, so load() the history first. */
export interface HistoryView {
  forItem(itemId: string): VariantRecord[];
  recentForCampaign(campaignId: string, n: number): VariantRecord[];
}

/** Variant history persisted through the Store interface (collection 'variants'). */
export class VariationHistory implements HistoryView {
  private records: VariantRecord[] = [];
  private nextSeq = 1;

  constructor(private readonly store: Store) {}

  async load(): Promise<this> {
    const rows = await this.store.list<VariantRecord>(VARIANTS_COLLECTION);
    this.records = rows.map((r) => r.value).sort((a, b) => a.seq - b.seq);
    this.nextSeq = (this.records.at(-1)?.seq ?? 0) + 1;
    return this;
  }

  all(): VariantRecord[] {
    return [...this.records];
  }

  forItem(itemId: string): VariantRecord[] {
    return this.records.filter((r) => r.variant.itemId === itemId);
  }

  recentForCampaign(campaignId: string, n: number): VariantRecord[] {
    return this.records.filter((r) => r.variant.campaignId === campaignId).slice(-n);
  }

  async record(variant: ContentVariant, platform: PlatformId, at: Date = new Date()): Promise<VariantRecord> {
    const rec: VariantRecord = { seq: this.nextSeq++, at: at.toISOString(), platform, variant };
    this.records.push(rec);
    await this.store.put(VARIANTS_COLLECTION, `${String(rec.seq).padStart(8, '0')}-${shortHash(variant.itemId, 8)}`, rec);
    return rec;
  }
}

// --- sampling ---------------------------------------------------------------

export interface SampleVariantInput {
  campaign: Pick<Campaign, 'id'>;
  itemId: string;
  personaId: string;
  platform: PlatformId;
  history: HistoryView;
  rng: Rng;
  config?: LoadedConfig;
  /** No tone may exceed this share of the last `window` campaign variants (including this one). Default 0.3. */
  maxToneShare?: number;
  window?: number;
  /** Angle ids this report supports (see availableAngles). When given, one is chosen. */
  angles?: readonly string[];
  /** Hook style ids to choose from (platforms with the fixed layout). When given, one is chosen. */
  hookStyles?: readonly string[];
  /** Post layout ids to choose from (see layouts.ts). When given, one is chosen. */
  layouts?: readonly string[];
  /** Optional measured-performance preferences. Missing policy preserves the existing sampler. */
  performanceWeights?: { layout?: Readonly<Record<string, number>>; angle?: Readonly<Record<string, number>>; hook?: Readonly<Record<string, number>>; opener?: Readonly<Record<string, number>> };
}

function pickWeighted<T>(items: readonly T[], weight: (t: T) => number, rng: Rng): T {
  const weights = items.map((i) => Math.max(0, weight(i)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(rng() * items.length)]!;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r < 0) return items[i]!;
  }
  return items.at(-1)!;
}

/** The options with the lowest use count (so unused ones win, and exhaustion cycles evenly). */
function leastUsed<T extends { id: string }>(options: readonly T[], used: ReadonlyMap<string, number>): T[] {
  const min = Math.min(...options.map((o) => used.get(o.id) ?? 0));
  return options.filter((o) => (used.get(o.id) ?? 0) === min);
}

function countBy<T>(items: readonly T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return m;
}

export function sampleVariant(input: SampleVariantInput): ContentVariant {
  const config = input.config ?? defaultConfig();
  const { rng, platform } = input;
  const maxShare = input.maxToneShare ?? 0.3;
  const windowSize = input.window ?? 20;

  const itemRecs = input.history.forItem(input.itemId);
  const recent = input.history.recentForCampaign(input.campaign.id, windowSize);
  const usedTone = countBy(itemRecs, (r) => r.variant.tone);
  const usedStructure = countBy(itemRecs, (r) => r.variant.structure);
  const usedOpener = countBy(itemRecs, (r) => r.variant.opener);
  const usedCta = countBy(itemRecs, (r) => r.variant.ctaVariant);
  const usedLength = countBy(itemRecs.filter((r) => r.platform === platform), (r) => r.variant.lengthClass);
  const usedCombos = new Set(itemRecs.map((r) => comboKey(r.variant)));

  // Tone: unused-for-item first, then the campaign share cap, then persona weights.
  const toneWindow = countBy(recent, (r) => r.variant.tone);
  let toneCandidates = leastUsed(TONES, usedTone);
  const withinShare = toneCandidates.filter((t) => ((toneWindow.get(t.id) ?? 0) + 1) / (recent.length + 1) <= maxShare);
  if (withinShare.length > 0) toneCandidates = withinShare;
  else {
    // Every item-fresh tone is over the cap (or the window is too small for a cap to be satisfiable):
    // keep item distinctness and take the ones least represented in the campaign window.
    toneCandidates = leastUsed(toneCandidates, toneWindow);
  }
  const personaWeights = PERSONA_TONE_WEIGHTS[input.personaId] ?? {};
  const tone = pickWeighted(toneCandidates, (t) => personaWeights[t.id] ?? 1, rng);

  const structure = pickWeighted(leastUsed(structuresFor(platform), usedStructure), () => 1, rng);

  const lengths = lengthClassesFor(platform, config.platformLimits[platform]);
  const ctas = ctaVariantsFor(config.brand);

  // A "common misconception" opener can invent a belief; use only source-safe openers for social text.
  const originalOpeners = platform === 'x' || platform === 'tumblr'
    ? OPENERS.filter((o) => ['stat-first', 'contrast', 'implication', 'plain-statement'].includes(o.id))
    : platform === 'facebook' || platform === 'linkedin' ? OPENERS.filter((o) => o.id !== 'misconception') : OPENERS;
  const permittedOpeners = originalOpeners.filter(o => (input.performanceWeights?.opener?.[o.id] ?? 1) > 0);
  const openers = permittedOpeners.length ? permittedOpeners : originalOpeners;
  let chosen: { opener: string; lengthClass: string; cta: string } | undefined;
  for (let attempt = 0; attempt < 25; attempt++) {
    const opener = pickWeighted(leastUsed(openers, usedOpener), o => input.performanceWeights?.opener?.[o.id] ?? 1, rng);
    const length = pickWeighted(leastUsed(lengths, usedLength), () => 1, rng);
    const cta = pickWeighted(leastUsed(ctas, usedCta), () => 1, rng);
    const candidate = { opener: opener.id, lengthClass: length.id, cta: cta.id };
    chosen = candidate;
    const key = comboKey({ tone: tone.id, structure: structure.id, ...candidate });
    if (!usedCombos.has(key)) break;
  }
  const c = chosen!;

  // Angle and hook are drawn AFTER the older axes, so seeds that used to give a variant still give
  // the same tone/structure/opener/length/CTA. Least-used for this report first, then least used
  // across the campaign window, so neither a report nor a campaign keeps repeating one argument.
  const pickLeastUsed = (ids: readonly string[] | undefined, pick: (v: ContentVariant) => string | undefined, weights?: Readonly<Record<string, number>>): string | undefined => {
    if (!ids || ids.length === 0) return undefined;
    const usedHere = countBy(itemRecs.filter((r) => pick(r.variant)), (r) => pick(r.variant)!);
    const usedAcross = countBy(recent.filter((r) => pick(r.variant)), (r) => pick(r.variant)!);
    const allowed = ids.filter(id => (weights?.[id] ?? 1) > 0);
    const options = (allowed.length ? allowed : ids).map((id) => ({ id }));
    if (weights && Object.keys(weights).length > 0 && allowed.length) {
      const fresh = leastUsed(options, usedHere);
      const priority = (id: string) => ((usedAcross.get(id) ?? 0) + 1) / (weights[id] ?? 1);
      const min = Math.min(...fresh.map(o => priority(o.id)));
      return pickWeighted(fresh.filter(o => priority(o.id) <= min + 1e-9), o => weights[o.id] ?? 1, rng).id;
    }
    return pickWeighted(leastUsed(leastUsed(options, usedHere), usedAcross), o => weights?.[o.id] ?? 1, rng).id;
  };
  const angle = pickLeastUsed(input.angles, (v) => v.angle, input.performanceWeights?.angle);
  const layout = pickLeastUsed(input.layouts, (v) => v.layout, input.performanceWeights?.layout);
  // Hook formulas are question shapes; layouts that open with a statement do not use them.
  const hookStyle = layout && !layoutById(layout).hookIsQuestion ? undefined : pickLeastUsed(input.hookStyles, (v) => v.hookStyle, input.performanceWeights?.hook);

  return ContentVariantSchema.parse({
    ...(angle ? { angle } : {}),
    ...(hookStyle ? { hookStyle } : {}),
    ...(layout ? { layout } : {}),
    campaignId: input.campaign.id,
    itemId: input.itemId,
    personaId: input.personaId,
    tone: tone.id,
    opener: c.opener,
    structure: structure.id,
    lengthClass: c.lengthClass,
    ctaVariant: c.cta,
    promptVersion: config.prompts.prompts.draft ?? config.prompts.version,
  });
}

function comboKey(v: { tone: string; opener?: string; structure: string; lengthClass?: string; ctaVariant?: string; cta?: string }): string {
  return [v.tone, v.opener, v.structure, v.lengthClass, v.ctaVariant ?? v.cta].join('|');
}

// --- reporting --------------------------------------------------------------

export interface AxisShare {
  id: string;
  count: number;
  share: number;
}

export interface DiversityReport {
  total: number;
  axes: Record<'tone' | 'opener' | 'structure' | 'lengthClass' | 'ctaVariant' | 'personaId', AxisShare[]>;
  distinctCombos: number;
  repeatedCombos: number;
  warnings: string[];
}

export function diversityReport(variants: readonly ContentVariant[], options: { maxShare?: number; minSample?: number } = {}): DiversityReport {
  const maxShare = options.maxShare ?? 0.4;
  const minSample = options.minSample ?? 5;
  const total = variants.length;
  const axis = (key: keyof DiversityReport['axes']): AxisShare[] =>
    [...countBy(variants, (v) => v[key]).entries()]
      .map(([id, count]) => ({ id, count, share: total === 0 ? 0 : count / total }))
      .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
  const axes = {
    tone: axis('tone'),
    opener: axis('opener'),
    structure: axis('structure'),
    lengthClass: axis('lengthClass'),
    ctaVariant: axis('ctaVariant'),
    personaId: axis('personaId'),
  };
  const combos = countBy(variants, (v) => comboKey(v));
  const warnings: string[] = [];
  if (total >= minSample) {
    for (const key of ['tone', 'opener', 'structure'] as const) {
      const top = axes[key][0];
      if (top && top.share > maxShare) warnings.push(`${key} "${top.id}" is ${(top.share * 100).toFixed(0)}% of ${total} variants (limit ${(maxShare * 100).toFixed(0)}%)`);
    }
  }
  const repeated = [...combos.values()].filter((n) => n > 1).length;
  if (repeated > 0) warnings.push(`${repeated} variant combination(s) repeat`);
  return { total, axes, distinctCombos: combos.size, repeatedCombos: repeated, warnings };
}

export interface SimilarPair {
  a: number;
  b: number;
  score: number;
}

export interface VariantSetCheck {
  ok: boolean;
  maxScore: number;
  threshold: number;
  flagged: SimilarPair[];
}

/**
 * Measures semantic duplication among texts that are variants of the SAME
 * item (shingle Jaccard from utils/similarity). The default threshold is a
 * starting point, not a calibrated value.
 */
export function checkVariantSet(texts: readonly string[], options: { threshold?: number } = {}): VariantSetCheck {
  const threshold = options.threshold ?? 0.5;
  const flagged: SimilarPair[] = [];
  let maxScore = 0;
  for (let a = 0; a < texts.length; a++) {
    for (let b = a + 1; b < texts.length; b++) {
      const score = textSimilarity(texts[a]!, texts[b]!);
      maxScore = Math.max(maxScore, score);
      if (score >= threshold) flagged.push({ a, b, score });
    }
  }
  return { ok: flagged.length === 0, maxScore, threshold, flagged };
}
