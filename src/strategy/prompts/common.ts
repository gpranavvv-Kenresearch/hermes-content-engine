import { outputFormatInstruction } from '../../contracts.js';
import type { Fact, Persona, PlatformId } from '../../schemas/index.js';
import { applyUtm } from '../../utils/utm.js';
import { defaultConfig, type LoadedConfig } from '../context.js';
import { MIN_DATA_YEAR } from '../../utils/years.js';
import { layoutById } from '../layouts.js';
import { TONES, findOption } from '../variation-axes.js';
import { shortHash } from '../../utils/hash.js';

/**
 * Shared prompt sections. All prompt text is built here from config + the
 * inputs passed in. Deliberately absent: any competitor name (naming them
 * primes the model), any planning-signal title/url, any fact not passed in.
 */

export interface BuiltPrompt {
  prompt: string;
  promptVersion: string;
}

export type PromptStage = 'research-brief' | 'outline' | 'draft' | 'editorial-rewrite';

export interface PromptContext {
  config?: LoadedConfig;
  platform: PlatformId;
  persona: Persona;
  /** Tone axis id from variation-axes TONES. */
  tone: string;
  /** The ONLY facts the model may use. */
  facts: readonly Fact[];
  /** Qualitative statements from the report page the model may restate (no figures). */
  notes?: readonly NoteLike[];
  /** Curated posts used for style only (see strategy/style-library.ts). */
  styleExamples?: readonly string[];
  /** Writing techniques adopted from reviewed repos (see repos/techniques.ts). */
  techniques?: readonly string[];
  /** Post layout id (see strategy/layouts.ts). Default: numbered-points. */
  layout?: string;
  /** Ken Research report page; UTM is applied here from config. */
  reportUrl: string;
}

export function resolveConfig(ctx: { config?: LoadedConfig }): LoadedConfig {
  return ctx.config ?? defaultConfig();
}

export function promptVersionFor(config: LoadedConfig, stage: PromptStage): string {
  return config.prompts.prompts[stage] ?? config.prompts.version;
}

export function sourceLink(ctx: PromptContext, config: LoadedConfig): string {
  const utm = config.utm[ctx.platform];
  if (!utm) throw new Error(`no UTM entry for platform "${ctx.platform}"`);
  return applyUtm(ctx.reportUrl, utm);
}

function section(title: string, lines: string[]): string {
  return `## ${title}\n${lines.join('\n')}`;
}

export function brandSection(config: LoadedConfig): string {
  return section('BRAND VOICE AND STANCE', [
    `Brand: ${config.brand.name}.`,
    `Voice: ${config.brand.tone}.`,
    `Stance: ${config.brand.stance}`,
    `Audience: ${config.brand.audience.join('; ')}.`,
  ]);
}

export function personaSection(persona: Persona): string {
  return section('PERSONA', [
    `Write for: ${persona.label}. ${persona.description}`,
    `Tone for this persona: ${persona.tone}`,
    `Depth: ${persona.depth}.`,
    `They care about: ${persona.priorities.join('; ')}.`,
    `Avoid: ${persona.avoid.join('; ')}.`,
    'Never name this audience or its job titles in the text or in hashtags (do not write "PE", "VC", "CXO" or similar as a label for the reader). Let the angle show who it is for.',
  ]);
}

export function toneSection(toneId: string): string {
  const tone = findOption(TONES, toneId);
  if (!tone) throw new Error(`unknown tone "${toneId}"`);
  return section('TONE FOR THIS PIECE', [`${tone.id}: ${tone.instruction}`]);
}

export function humanToneSection(): string {
  return section('HUMAN WRITING GUIDANCE', [
    '- Prefer specific details (a period, a place, a segment) over general statements.',
    '- Vary sentence length: mix short sentences with longer ones. Do not open consecutive sentences the same way.',
    '- Write like a senior analyst talking to a peer. No stock openers, no filler transitions, no summary paragraph that repeats the text.',
    '- Do not use stock AI phrasing or empty intensifiers. One concrete point beats three vague ones.',
    '- Use plain words. Explain a term once if the reader may not know it.',
  ]);
}

export function styleBansSection(config: LoadedConfig): string {
  const chars = config.brand.bannedCharacters.map((c) => `"${c}"`).join(' ');
  return section('STYLE RULES', [
    `Never use these phrases: ${config.brand.bannedPhrases.map((p) => `"${p}"`).join('; ')}.`,
    `Never use these promotional words: ${config.brand.bannedPromoWords.join(', ')}.`,
    `Never use these characters: ${chars}. Use a comma, colon or a plain hyphen instead.`,
  ]);
}

/** Worded generically on purpose. Never list the firms to avoid. */
export function sourceRuleSection(config: LoadedConfig): string {
  return section('SOURCE RULE', [
    `Cite only ${config.brand.name} and official government or regulatory bodies.`,
    'Do not mention, name, quote or link any other research publisher, consultancy, data vendor or analyst firm, and do not attribute any statement to one.',
    'Do not add outside figures, outside sources or recalled statistics.',
    `Years: write a year only exactly as it appears in the FACTS (the period of the figure). Never mention any year before ${MIN_DATA_YEAR}. If a fact has no period, write no year for it. Do not add years of your own.`,
  ]);
}

export function formatFactValue(f: Fact): string {
  const v = f.precision === undefined ? String(f.value) : f.value.toFixed(f.precision);
  return `${v} ${f.unit}`;
}

/**
 * The FACTS block contains ONLY the facts passed in; SOURCE NOTES (qualitative statements from the
 * same report page) follow when there are any. Nothing else may be stated as a finding.
 */
export function factsSection(facts: readonly Fact[], notes: readonly NoteLike[] = []): string {
  const core = factsBlock(facts);
  const background = notes.filter((n) => n.tier === 'other');
  const backgroundBlock =
    background.length === 0
      ? ''
      : `\n\n${section('NEUTRAL INDUSTRY BACKGROUND (general context, no source to name)', [
          ...background.map((n) => `- [${n.id}] ${n.text}`),
          'Use these only as general, number-free context, restated in your own words as plain neutral statements or bullets (growth drivers, structure, shifts).',
          'Do NOT write "according to", "Ken Research notes/says/finds" or any other attribution for them, do not name or hint at where they came from, and add no figure, name or detail beyond them.',
          'Ken Research appears in the post as the publisher: its name, the report link, #KenResearch and the call to read the full report.',
        ])}`;
  notes = notes.filter((n) => n.tier !== 'other');
  if (notes.length === 0) return `${core}${backgroundBlock}`;
  const noteBlock = section('SOURCE NOTES (from the Ken Research report page)', [
    ...notes.map((n) => `- [${n.id}] ${n.text}`),
    'You may restate these in your own words and attribute them to Ken Research. Add no detail, names, causes or numbers beyond what they say.',
    'Attribute only the FACTS and SOURCE NOTES to Ken Research. Never attribute your own interpretation, advice or forecast to Ken Research; phrase it as a consideration for the reader ("this suggests", "decision-makers should weigh").',
  ]);
  return `${core}\n\n${noteBlock}${backgroundBlock}`;
}

export interface NoteLike {
  id: string;
  text: string;
  /** Absent for notes from the report page. 'other' notes are neutral background only. */
  tier?: string;
  sourceName?: string;
}

/** What the post argues, and which source notes it should lead with. */
export function angleSection(angle: { label: string; instruction: string }, primaryNotes: readonly NoteLike[]): string {
  const lines = [`Argue this angle: ${angle.label}. ${angle.instruction}`];
  if (primaryNotes.length > 0) {
    lines.push(
      `Build the content mainly from these source notes: ${primaryNotes.map((n) => `[${n.id}]`).join(', ')}. Other notes may support a point but must not lead it.`,
    );
  } else {
    lines.push('Build the points from the FACTS; use source notes only to support them.');
  }
  return section('ANGLE FOR THIS POST', lines);
}

/** The shape of the opening question. */
export function hookSection(hook: { instruction: string }): string {
  return section('HOOK STYLE', [hook.instruction, 'Keep it ONE question. Use only figures from the FACTS.']);
}

/** Curated posts (leaders, house reference) shown for style only. */
export function styleExamplesSection(examples: readonly string[]): string | null {
  if (examples.length === 0) return null;
  return section('STYLE EXAMPLES (curated posts, for style only)', [
    'Match their rhythm, hook shape, paragraph length and clarity. NEVER copy their wording, names, facts or figures; those belong to other reports and are not evidence for this one.',
    ...examples.map((e, i) => `Example ${i + 1}:\n"""\n${e}\n"""`),
  ]);
}

/** Techniques adopted from reviewed repos: structure and wording only, never a license to add content. */
export function techniquesSection(techniques: readonly string[]): string | null {
  if (techniques.length === 0) return null;
  return section('WRITING TECHNIQUES (adopted from reviewed sources)', [
    'Apply the ones that fit this post. They are about structure and wording only. A technique never lets you add a figure, quote, source, name or claim that is not in FACTS or SOURCE NOTES; if a technique would need one, skip it.',
    ...techniques.map((t) => `- ${t}`),
  ]);
}

/** Latest measured rules occupy one replaceable prompt slot; they never accumulate between runs. */
export function performanceGuidanceSection(rules: readonly string[]): string | null {
  if (rules.length === 0) return null;
  return section('ACTIVE MEASURED PERFORMANCE GUIDANCE', [
    'Apply these platform-specific corrections. They never override FACTS, SOURCE NOTES, the selected approved layout, platform limits or hard validation.',
    ...rules.map(rule => `- ${rule}`),
  ]);
}

function factsBlock(facts: readonly Fact[]): string {
  if (facts.length === 0) {
    return section('FACTS', ['No facts are provided. Use no numbers at all.', 'Report FACT_IDS: none.']);
  }
  const lines = facts.map((f) => {
    const parts = [
      f.currency ? `currency: ${f.currency}` : '',
      f.period ? `period: ${f.period}` : '',
      f.geography ? `geography: ${f.geography}` : '',
      f.marketDefinition ? `market: ${f.marketDefinition}` : '',
      `type: ${f.factType}`,
    ].filter(Boolean);
    if (f.sourceTier === 'government') parts.push(`source: ${f.sourceName ?? 'a government body'} (government/regulatory)`);
    if (f.sourceTier === 'ken_research') parts.push(`source: Ken Research report "${f.sourceName ?? f.sourceTitle}"`);
    return `- [${f.id}] ${f.metric} = ${formatFactValue(f)} (${parts.join('; ')})`;
  });
  const hasGov = facts.some((f) => f.sourceTier === 'government');
  const hasKenOther = facts.some((f) => f.sourceTier === 'ken_research');
  return section('FACTS', [
    ...lines,
    ...(hasGov ? ['A figure marked "source: ... (government/regulatory)" must be attributed, in the same sentence, to that named body. Never attribute it to Ken Research.'] : []),
    ...(hasKenOther
      ? ["A figure marked \"source: Ken Research report ...\" comes from a DIFFERENT Ken Research report than the one linked in this post. Attribute it to Ken Research and state its scope (geography and market) exactly as given; never present it as the figure for this post's own report."]
      : []),
    'Use no numbers other than the facts above. State each figure with its period when given. A shared geography may be stated ONCE for several figures in the same sentence when all share that scope; do not repeat it after each figure. Keep country, regional and global scopes explicit whenever they differ.',
    'Say only what these facts support. Do not invent or imply causes, drivers, segments, regulations, policies, incentives, companies, trends, forecasts or comparisons that the facts do not state. If a point is not in the facts, leave it out.',
    'Do not describe growth as a multiple ("doubles", "triples"); state only the figures given.',
    'In the FACT_IDS line, report the ids of every fact you used.',
  ]);
}

export function platformSection(config: LoadedConfig, platform: PlatformId): string {
  const l = config.platformLimits[platform];
  const lines = [`Platform: ${platform}.`];
  if (l.hardMaxChars !== null) {
    lines.push(`Hard cap: ${l.hardMaxChars} characters for the final text. Never exceed it.`);
    if (l.formatting.boldBrand || l.formatting.boldFigures) {
      lines.push(
        'The cap is measured on the FINAL text: every bold letter or digit counts as 2 characters and every blank line as 1, so the text you write must stay clearly below the cap.',
      );
    }
  } else {
    lines.push('No platform hard cap, but stay concise and purposeful.');
  }
  if (l.targetMinChars !== null || l.targetMaxChars !== null) {
    lines.push(`Target length: ${l.targetMinChars ?? 0} to ${l.targetMaxChars ?? l.hardMaxChars} characters.`);
  }
  if (l.urlCountsAs !== null) lines.push(`Every URL counts as ${l.urlCountsAs} characters.`);
  if (l.hashtags.max > 0) lines.push(`Hashtags: ${l.hashtags.min} to ${l.hashtags.max}, placed at the end.`);
  else lines.push('Do not use hashtags.');
  if (l.requireTitle) lines.push('Begin with a title line.');
  return section('PLATFORM LIMITS', lines);
}

/**
 * Brand mention (mandatory everywhere) and bold rules. Facebook and LinkedIn do not render
 * markdown, so the model writes **double asterisks** and they are converted to Unicode bold
 * after validation. Other platforms get plain text.
 */
export function formattingSection(config: LoadedConfig, platform: PlatformId): string {
  const brand = config.brand.name;
  const f = config.platformLimits[platform].formatting;
  const lines = [`Name "${brand}" in a substantive finding, preferably the first evidence sentence; a hashtag or report-link label alone does not count. Preserve official-source attribution.`];
  if (f.selectiveBold) {
    return section('BRAND AND FORMATTING', [...lines,
      ...(f.boldBrand ? [`Every mention of "${brand}" must be **${brand}**.`] : []),
      'Keep the rest plain. Optionally emphasize ONE short key figure with **bold**. Do not bold every number, year or keyword.',
    ]);
  }
  if (f.boldBrand) lines.push(`Wrap every mention of "${brand}" in double asterisks: **${brand}**.`);
  if (f.boldFigures) {
    lines.push(
      'Wrap every currency amount and every percentage or CAGR figure in double asterisks, together with its unit and currency, for example **USD 4.2 billion** and **7.2%**.',
    );
  }
  if (f.boldBrand || f.boldFigures) {
    lines.push('Bold nothing else: no sentences, headings, hashtags or links. The double asterisks are converted to real bold when the post is published.');
  } else {
    lines.push('Plain text only. Do not use asterisks or any markdown on this platform.');
  }
  return section('BRAND AND FORMATTING', lines);
}

/**
 * The fixed Facebook/LinkedIn layout (from the reference post). Returns null for platforms
 * with a free layout. Hashtag counts come from the platform limits.
 */
export function layoutSection(config: LoadedConfig, platform: PlatformId, layoutId?: string): string | null {
  const limit = config.platformLimits[platform];
  if (platform === 'tumblr') return section('TUMBLR POST CONTRACT', [
    'Write one concise B2B market brief: a specific finding, its supplied evidence and one supported business consideration in short paragraphs. Keep source, geography, period and forecast wording clear.',
    'Use the primary keyword naturally and name Ken Research in the substantive body. Plain text, one report link, then topical hashtags. No numbered long-form layout, bold or mandatory discussion question. Follow the configured editorial length target.',
  ]);
  if (platform === 'x') {
    return section('X POST CONTRACT', [
      'One standalone post, not a thread. Lead with the market topic and one source-backed finding; add one concise business implication or evaluation consideration only when supported.',
      'Use the primary keyword naturally near the start, once is enough. Attribute the finding to Ken Research or its actual official source. Keep periods, geography and forecast wording; use fewer figures rather than dropping scope.',
      'Include the supplied report link once, then 1-2 relevant hashtags. The link is the CTA; no extra engagement question is required. No clickbait, invented common beliefs, job-title labels or keyword stuffing.',
      'Plain text, no bold, lists or long-form sections. Aim within the target band; never exceed 280 characters counting each URL as 23.',
    ]);
  }
  if (limit.formatting.layout !== 'numbered_points') return null;
  const tag = `#${config.brand.name.replace(/\s+/g, '')}`;
  const { min, max } = limit.hashtags;
  const layout = layoutById(layoutId, platform);
  if (platform === 'linkedin' || platform === 'facebook') {
    return section('POST LAYOUT (follow exactly)', [
      `Layout for this post: ${layout.label}.`,
      ...layout.steps,
      'One central idea. Hook: at most 25 words; use the selected statement, statistic or source-quote lead. Use the primary keyword naturally near the start; no keyword stuffing.',
      'State headline figures once. Each paragraph adds a different insight; do not repeat country dominance in several points. Use plain language and 1-2 sentences per paragraph.',
      'End: strategic implication, neutral report-link line, ONE discussion question after the link, then hashtags starting with ' + tag + ` (${min}-${max} total). No other questions or competing CTAs.`,
      'Ask about one specific experience, obstacle or decision from the post. Avoid generic "Which matters most?" menus and engagement bait.',
      layout.listRule,
      'Country detail must come from evidence. Do not split a regional observation into invented country claims. No emoji or em dashes.',
    ]);
  }
  const tail = [
    'ONE closing question for decision makers, on its own line.',
    'One line inviting the reader to the full report that ends with a colon (for example "For decision-makers evaluating this market, review the full market breakdown here:"), and the source link on the next line by itself.',
    'ONE short engagement question for the reader, on its own line.',
    `Last line: the hashtags. Start with ${tag}, then topical tags; ${min} to ${max} hashtags in total.`,
  ];
  const steps = [...layout.steps, ...tail].map((t, i) => `${i + 1}. ${i >= layout.steps.length ? 'Then ' : ''}${t}`);
  return section('POST LAYOUT (follow exactly)', [
    `Layout for this post: ${layout.label}.`,
    ...steps,
    'The two questions must serve different purposes: the closing question asks about a strategic implication; the engagement question asks for a concrete experience, example or response. Do not paraphrase the same question twice.',
    `Separate every block and every list item with one blank line. ${layout.listRule} Use no emoji and no em dashes anywhere.`,
  ]);
}

/** Vary the reader invitation within the existing single-question ending. */
export function discussionQuestionSection(platform: PlatformId, key: string): string | null {
  if (platform !== 'linkedin' && platform !== 'facebook') return null;
  const directions = [
    'Ask about a concrete implementation bottleneck the reader has encountered with one capability discussed in this post.',
    'Ask what observable evidence would change the reader\'s assessment of one specific trade-off discussed in this post.',
    'Invite one practical lesson from evaluating or deploying one capability named in this post.',
    'Ask what the reader would check first when making one specific decision raised by this post.',
  ];
  const selected = directions[parseInt(shortHash(key, 8), 16) % directions.length]!;
  return section('DISCUSSION QUESTION', [selected,
    'One short question after the link; use a supported premise, no private figures. Avoid a generic ranking of the bullets or forced option menus.',
  ]);
}

/** The link appears exactly once in the whole prompt: here, or in the embedded draft when `alreadyInDraft`. */
export function linkSection(link: string, alreadyInDraft = false): string {
  if (alreadyInDraft) {
    return section('SOURCE LINK', [
      'The draft already contains the source link. Keep it exactly once, unchanged, and add no other URL.',
    ]);
  }
  return section('SOURCE LINK', [
    `The finished text must contain this link exactly once, unchanged: ${link}`,
    'Add no other URL.',
  ]);
}

export function outputSection(): string {
  return section('OUTPUT FORMAT', [outputFormatInstruction()]);
}

export function join(sections: string[]): string {
  return `${sections.join('\n\n')}\n`;
}
