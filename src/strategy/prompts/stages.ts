import type { Brief, ContentVariant } from '../../schemas/index.js';
import { OPENERS, STRUCTURES, ctaVariantsFor, findOption, lengthClassesFor } from '../variation-axes.js';
import {
  brandSection,
  factsSection,
  angleSection,
  formattingSection,
  hookSection,
  layoutSection,
  discussionQuestionSection,
  styleExamplesSection,
  techniquesSection,
  performanceGuidanceSection,
  humanToneSection,
  join,
  linkSection,
  outputSection,
  personaSection,
  platformSection,
  promptVersionFor,
  resolveConfig,
  sourceLink,
  sourceRuleSection,
  styleBansSection,
  toneSection,
  type BuiltPrompt,
  type NoteLike,
  type PromptContext,
} from './common.js';

type BriefView = Pick<Brief, 'angle' | 'keywords' | 'beatPoints'>;

function briefSection(brief: BriefView, itemTitle?: string, platform?: PromptContext['platform']): string {
  const lines = [`Angle: ${brief.angle}`];
  if (itemTitle) lines.unshift(`Report topic: ${itemTitle}`);
  if (brief.keywords.length > 0) {
    lines.push(`Primary keyword: ${brief.keywords[0]}. Use this phrase naturally in the visible post body, not only in hashtags or the URL.`);
    if (brief.keywords.length > 1) lines.push(`Optional related terms: ${brief.keywords.slice(1).join('; ')}.`);
  }
  if (platform !== 'x' && brief.beatPoints.length > 0) {
    lines.push('Topical gaps worth covering (generic, not facts):', ...brief.beatPoints.map((b) => `- ${b}`));
  }
  return `## BRIEF\n${lines.join('\n')}`;
}

function common(ctx: PromptContext, config = resolveConfig(ctx)): string[] {
  const layout = layoutSection(config, ctx.platform, ctx.layout);
  const discussion = discussionQuestionSection(ctx.platform, `${ctx.reportUrl}|${ctx.tone}|${ctx.layout ?? ''}`);
  // Only the selected LinkedIn format enters the prompt, without the old reference
  // post or overlapping technique lists.
  if (ctx.platform === 'x' || ctx.platform === 'tumblr' || ctx.platform === 'linkedin' || ctx.platform === 'facebook') {
    const measured = (ctx.techniques ?? []).filter(rule => rule.startsWith('Latest measured '));
    const adopted = (ctx.techniques ?? []).filter(rule => !rule.startsWith('Latest measured '));
    return [
      `## WRITER\nWrite for ${config.brand.name} as an analyst sharing one useful insight with a peer. Audience: ${ctx.persona.label}; priorities: ${ctx.persona.priorities.join(', ')}. Never label the reader by job title. Use plain, specific language and natural paragraphs.`,
      toneSection(ctx.tone),
      styleBansSection(config),
      `## SOURCE RULE\nUse supplied FACTS and SOURCE NOTES only. ${ctx.platform === 'x' ? 'Cite only Ken Research and official government or regulatory bodies; attribute each finding to its actual source.' : 'Cite Ken Research or the named official body.'} No outside research publishers, invented experience, quotes, statistics or causal claims. Distinguish projections from actuals; retain periods and scopes. No dates before 2024.`,
      factsSection(ctx.facts, ctx.notes),
      platformSection(config, ctx.platform),
      formattingSection(config, ctx.platform),
      ...(layout ? [layout] : []),
      ...(discussion ? [discussion] : []),
      ...(measured.length ? [performanceGuidanceSection(measured)!] : []),
      ...(ctx.platform === 'x' && adopted.length ? [techniquesSection(adopted)!] : []),
      ...(ctx.platform === 'x' && ctx.styleExamples?.length ? [styleExamplesSection(ctx.styleExamples.slice(0, 1))!] : []),
    ];
  }
  const style = styleExamplesSection(ctx.styleExamples ?? []);
  const techniques = techniquesSection(ctx.techniques ?? []);
  return [
    brandSection(config),
    personaSection(ctx.persona),
    toneSection(ctx.tone),
    humanToneSection(),
    styleBansSection(config),
    sourceRuleSection(config),
    factsSection(ctx.facts, ctx.notes),
    platformSection(config, ctx.platform),
    formattingSection(config, ctx.platform),
    ...(layout ? [layout] : []),
    ...(techniques ? [techniques] : []),
    ...(style ? [style] : []),
  ];
}

export interface ResearchBriefInput extends PromptContext {
  brief: BriefView;
  itemTitle?: string;
}

/** Stage 1: turn the brief and facts into a research plan. */
export function buildResearchBriefPrompt(input: ResearchBriefInput): BuiltPrompt {
  const config = resolveConfig(input);
  const task = [
    '## TASK',
    'You are preparing a research brief for a writer. Using only the FACTS above, list:',
    '1. The single strongest finding and why a senior reader would care.',
    '2. Three supporting points, each tied to a fact id.',
    '3. One caveat or limit of the evidence.',
    '4. Questions the reader will ask next.',
    'Put the brief in the text part of the reply. Do not invent figures.',
  ].join('\n');
  return {
    prompt: join([
      ...common(input, config),
      briefSection(input.brief, input.itemTitle, input.platform),
      task,
      linkSection(sourceLink(input, config)),
      outputSection(),
    ]),
    promptVersion: promptVersionFor(config, 'research-brief'),
  };
}

export interface OutlineInput extends PromptContext {
  brief: BriefView;
  itemTitle?: string;
  /** Optional pillar section headings to follow (from evergreen.ts). */
  pillarHeadings?: readonly string[];
}

/** Stage 2: produce an outline. */
export function buildOutlinePrompt(input: OutlineInput): BuiltPrompt {
  const config = resolveConfig(input);
  const task = [
    '## TASK',
    'Write an outline for the piece: a working title, then ordered sections with one line each on what the section says and which fact ids it uses.',
    ...(input.pillarHeadings && input.pillarHeadings.length > 0
      ? ['Follow these section headings in order:', ...input.pillarHeadings.map((h) => `- ${h}`)]
      : []),
    'Do not write the full text yet. Use no figures other than the FACTS above.',
  ].join('\n');
  return {
    prompt: join([
      ...common(input, config),
      briefSection(input.brief, input.itemTitle, input.platform),
      task,
      linkSection(sourceLink(input, config)),
      outputSection(),
    ]),
    promptVersion: promptVersionFor(config, 'outline'),
  };
}

export interface DraftInput extends PromptContext {
  brief: BriefView;
  itemTitle?: string;
  variant: ContentVariant;
  /** Optional approved outline text from the outline stage. */
  outlineText?: string;
  /** What this post argues and the notes it should lead with (chosen by the variation engine). */
  angle?: { label: string; instruction: string; primaryNotes: readonly NoteLike[] };
  /** Shape of the opening question (layout platforms). */
  hook?: { instruction: string };
}

/** Stage 3: the per-platform draft, steered by the variation axes. */
export function buildDraftPrompt(input: DraftInput): BuiltPrompt {
  const config = resolveConfig(input);
  const { variant } = input;
  const opener = findOption(OPENERS, variant.opener);
  const structure = findOption(STRUCTURES, variant.structure);
  const lengths = lengthClassesFor(input.platform, config.platformLimits[input.platform]);
  const length = lengths.find((l) => l.id === variant.lengthClass);
  const cta = ctaVariantsFor(config.brand).find((c) => c.id === variant.ctaVariant);
  if (!opener || !structure || !length || !cta) {
    throw new Error(`variant does not resolve against axis tables for platform "${input.platform}"`);
  }
  const fixedLayout = config.platformLimits[input.platform].formatting.layout === 'numbered_points';
  const variantSection = [
    '## VARIATION AXES FOR THIS DRAFT',
    fixedLayout
      ? 'Opener: a short lead of at most 25 words in the selected POST LAYOUT: a statement, statistic, source quote, or ONE question hook. The single discussion question still goes after the report link.'
      : `Opener (${opener.id}): ${opener.instruction}`,
    fixedLayout ? 'Structure: follow the POST LAYOUT above exactly.' : `Structure (${structure.id}): ${structure.instruction}`,
    `Length class (${length.id}): aim for ${length.minChars} to ${length.maxChars} characters.`,
    input.platform === 'x' || input.platform === 'tumblr' ? 'Call to action: the supplied report link once; no forced discussion question.' : fixedLayout ? 'Call to action: report link, then one specific discussion question.' : `Call to action: ${cta.instruction}`,
  ].join('\n');
  const task = [
    '## TASK',
    `Write the ${input.platform} text now. It is a finished piece that can be published as is.`,
    'Follow the tone, opener, structure and length above. Stay inside the platform hard cap.',
  ].join('\n');
  const outline = input.outlineText ? [`## APPROVED OUTLINE\n${input.outlineText}`] : [];
  const direction = [
    ...(input.angle ? [angleSection(input.angle, input.angle.primaryNotes)] : []),
    ...(input.hook && !fixedLayout ? [hookSection(input.hook)] : []),
  ];
  return {
    prompt: join([
      ...common(input, config),
      briefSection(input.brief, input.itemTitle, input.platform),
      ...direction,
      variantSection,
      ...outline,
      task,
      linkSection(sourceLink(input, config)),
      outputSection(),
    ]),
    promptVersion: promptVersionFor(config, 'draft'),
  };
}

export interface EditorialRewriteInput extends PromptContext {
  draftText: string;
  /** Human-readable problems found by validation. */
  issues: readonly string[];
  variant?: ContentVariant;
}

/** Stage 4: rewrite a draft to fix named problems while keeping facts and voice. */
export function buildEditorialRewritePrompt(input: EditorialRewriteInput): BuiltPrompt {
  const config = resolveConfig(input);
  const link = sourceLink(input, config);
  const inDraft = input.draftText.includes(link);
  const task = [
    '## TASK',
    'Rewrite the DRAFT below as a careful human editor would. Fix every listed problem, keep the meaning, keep the facts exactly as stated, and keep it inside the platform cap.',
    'Remove stock phrasing, vary sentence rhythm, and cut filler. Do not add new figures or sources.',
    input.issues.length > 0 ? ['Problems to fix:', ...input.issues.map((i) => `- ${i}`)].join('\n') : 'No specific problems were listed; improve clarity and voice.',
  ].join('\n');
  return {
    prompt: join([
      ...common(input, config),
      task,
      `## DRAFT\n${input.draftText}`,
      linkSection(link, inDraft),
      outputSection(),
    ]),
    promptVersion: promptVersionFor(config, 'editorial-rewrite'),
  };
}
