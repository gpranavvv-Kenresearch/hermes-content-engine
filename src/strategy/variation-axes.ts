import type { BrandConfig, PlatformId, PlatformLimit } from '../schemas/index.js';

/** Variation axes as data. Instructions are what draft prompts show the model. */

export interface AxisOption {
  id: string;
  instruction: string;
}

export const TONES: AxisOption[] = [
  { id: 'urgent', instruction: 'Time-sensitive and direct. Make the reader feel why this matters now, without hype or exclamation.' },
  { id: 'informative', instruction: 'Plain, neutral and clear. Report what the evidence says and let it stand.' },
  { id: 'analytical', instruction: 'Careful and structured. Weigh the numbers, name the drivers and say what they imply.' },
  { id: 'contrarian', instruction: 'Highlight an evidence-backed tension without inventing a prevailing belief. Be precise about what the data does and does not show.' },
  { id: 'cautionary', instruction: 'Measured and risk-aware. Point out what could undercut the headline figure.' },
  { id: 'opportunity-led', instruction: 'Frame the findings as openings for a decision maker. Stay grounded in the facts, no promises.' },
  { id: 'data-led', instruction: 'Use the strongest supplied figure once, with its period and geography. Develop its implications without restating it in every paragraph.' },
  { id: 'explanatory', instruction: 'Teach the reader how the market works. Define terms briefly and connect cause to effect.' },
  { id: 'comparative', instruction: 'Set the figure against its own context, such as segments or periods that are in the supplied facts.' },
  { id: 'forward-looking', instruction: 'Focus on what the forecast period implies and what would change it. Separate observed from forecast.' },
];

export const OPENERS: AxisOption[] = [
  { id: 'stat-first', instruction: 'Open with the single strongest supplied figure, stated with its period and geography.' },
  { id: 'question', instruction: 'Open with a pointed question a senior reader would actually ask.' },
  { id: 'scenario', instruction: 'Open with a short, concrete decision scenario the reader may recognise.' },
  { id: 'contrast', instruction: 'Open by contrasting two things in the facts, such as two periods or two segments.' },
  { id: 'implication', instruction: 'Open with the implication for a decision, then back it with the figure.' },
  { id: 'definition', instruction: 'Open with a one-line definition of what is being measured.' },
  { id: 'misconception', instruction: 'Open by naming a common misreading, then correct it with the evidence.' },
  { id: 'plain-statement', instruction: 'Open with a calm, declarative statement of the main finding.' },
];

export interface StructureOption extends AxisOption {
  /** Platforms where this structure fits. 'all' means every platform. */
  platforms: PlatformId[] | 'all';
}

const LONG_FORM: PlatformId[] = ['facebook', 'linkedin', 'blog', 'tumblr', 'instagram'];

export const STRUCTURES: StructureOption[] = [
  { id: 'claim-evidence-implication', platforms: 'all', instruction: 'Claim first, then the evidence, then what it means for the reader.' },
  { id: 'problem-insight-action', platforms: 'all', instruction: 'Name a problem, give the insight the data supports, close with a consideration for action.' },
  { id: 'question-answer', platforms: 'all', instruction: 'Pose a question, answer it directly, then add one supporting detail.' },
  { id: 'contrast-before-after', platforms: 'all', instruction: 'Show a before and an after, or a this-versus-that, built from the supplied facts.' },
  { id: 'stat-so-what', platforms: 'all', instruction: 'State the figure, then a so-what sentence, then one caveat.' },
  { id: 'myth-reality', platforms: 'all', instruction: 'State a common belief, then the reality the data shows.' },
  { id: 'numbered-points', platforms: LONG_FORM, instruction: 'Numbered points ("1.", "2.", ...), each tied to a fact or source note and to what it means for a decision maker.' },
  { id: 'short-narrative', platforms: ['facebook', 'linkedin', 'blog', 'tumblr'], instruction: 'A compact narrative arc: situation, tension, evidence, resolution.' },
  { id: 'headline-bullets', platforms: ['facebook', 'linkedin', 'blog', 'instagram'], instruction: 'A headline sentence followed by short bullet lines, each carrying one fact or implication.' },
];

/**
 * Platforms whose platform-limits `formatting.layout` is 'numbered_points': the post layout is
 * fixed (hook question, numbered points, closing question, link, engagement question, hashtags),
 * so there is exactly one structure. A test keeps this list in step with the config.
 */
export const NUMBERED_LAYOUT_PLATFORMS: readonly PlatformId[] = ['facebook', 'linkedin'];

export function structuresFor(platform: PlatformId): StructureOption[] {
  if (NUMBERED_LAYOUT_PLATFORMS.includes(platform)) return STRUCTURES.filter((s) => s.id === 'numbered-points');
  if (platform === 'x' || platform === 'tumblr') return STRUCTURES.filter((s) => ['claim-evidence-implication', 'problem-insight-action', 'contrast-before-after', 'stat-so-what'].includes(s.id));
  return STRUCTURES.filter((s) => s.platforms === 'all' || s.platforms.includes(platform));
}

export interface LengthClass {
  id: string;
  minChars: number;
  maxChars: number;
}

/** Raw per-platform classes. lengthClassesFor() clamps them to the configured limits. */
const RAW_LENGTH_CLASSES: Record<PlatformId, LengthClass[]> = {
  x: [
    { id: 'tight', minChars: 120, maxChars: 200 },
    { id: 'standard', minChars: 200, maxChars: 256 },
  ],
  facebook: [
    { id: 'compact', minChars: 1000, maxChars: 1250 },
    { id: 'standard', minChars: 1250, maxChars: 1500 },
    { id: 'full', minChars: 1500, maxChars: 1700 },
  ],
  linkedin: [
    { id: 'compact', minChars: 1000, maxChars: 1250 },
    { id: 'standard', minChars: 1250, maxChars: 1500 },
    { id: 'full', minChars: 1500, maxChars: 1700 },
  ],
  tumblr: [
    { id: 'short', minChars: 600, maxChars: 800 },
    { id: 'standard', minChars: 800, maxChars: 1000 },
  ],
  instagram: [
    { id: 'short', minChars: 120, maxChars: 170 },
    { id: 'standard', minChars: 170, maxChars: 230 },
  ],
  mastodon: [
    { id: 'short', minChars: 200, maxChars: 300 },
    { id: 'standard', minChars: 300, maxChars: 400 },
  ],
  blog: [
    { id: 'concise', minChars: 3000, maxChars: 4500 },
    { id: 'standard', minChars: 4500, maxChars: 7000 },
    { id: 'deep', minChars: 7000, maxChars: 10000 },
  ],
};

/** Length classes for a platform, clamped so no class can exceed the hard cap or the target band. */
export function lengthClassesFor(platform: PlatformId, limit: Pick<PlatformLimit, 'hardMaxChars' | 'targetMinChars' | 'targetMaxChars'>): LengthClass[] {
  return RAW_LENGTH_CLASSES[platform].map((c) => {
    let max = c.maxChars;
    if (limit.targetMaxChars !== null) max = Math.min(max, limit.targetMaxChars);
    if (limit.hardMaxChars !== null) max = Math.min(max, limit.hardMaxChars);
    let min = c.minChars;
    if (limit.targetMinChars !== null) min = Math.max(min, limit.targetMinChars);
    return { id: c.id, minChars: Math.min(min, max), maxChars: max };
  });
}

export const CTA_PLACEMENTS: AxisOption[] = [
  { id: 'closing-line', instruction: 'Put the attribution in the body and the source link alone in the final line.' },
  { id: 'after-key-finding', instruction: 'Place the source link right after the key finding, then continue with the implication.' },
  { id: 'closing-sentence', instruction: 'End with one sentence that uses the attribution wording and carries the source link.' },
  { id: 'own-paragraph', instruction: 'Give the source link its own short paragraph near the end, introduced by the attribution wording.' },
];

export interface CtaVariant {
  id: string;
  attributionPhrase: string;
  placement: string;
  instruction: string;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * CTA variants derived from the brand attribution phrases x placements. Every
 * variant keeps the rule that the source link appears exactly once.
 */
export function ctaVariantsFor(brand: Pick<BrandConfig, 'attributionPhrases'>): CtaVariant[] {
  return brand.attributionPhrases.flatMap((phrase) =>
    CTA_PLACEMENTS.map((p) => ({
      id: `${p.id}:${slug(phrase)}`,
      attributionPhrase: phrase,
      placement: p.id,
      instruction: `Attribute the main finding with the wording "${phrase}". ${p.instruction} The source link must appear exactly once in the whole text.`,
    })),
  );
}

/** Mild persona-to-tone preferences (weight 1 is neutral). Data, not behaviour: edit freely. */
export const PERSONA_TONE_WEIGHTS: Record<string, Record<string, number>> = {
  cxo: { urgent: 2, 'opportunity-led': 2, informative: 1.5 },
  'pe-vc': { 'data-led': 2, analytical: 2, comparative: 1.5, cautionary: 1.5 },
  'strategy-head': { analytical: 1.5, explanatory: 2, 'forward-looking': 2, comparative: 1.5 },
};

export function findOption<T extends AxisOption>(table: readonly T[], id: string): T | undefined {
  return table.find((o) => o.id === id);
}
