import type { LoadedConfig } from '../config/index.js';
import { outputFormatInstruction } from '../contracts.js';
import type { Fact, PlatformId, ValidationIssue } from '../schemas/index.js';
import { layoutById } from '../strategy/layouts.js';
import { layoutSection } from '../strategy/prompts/common.js';
import { extractUrls } from '../utils/text.js';
import { applyUtm, isKenResearchUrl } from '../utils/utm.js';

export interface RewritePromptInput {
  text: string;
  /** The EXACT issues to fix; the prompt never asks for anything else. */
  issues: readonly ValidationIssue[];
  facts: readonly Fact[];
  platform: PlatformId;
  config: LoadedConfig;
  /** Ken Research report URL (without UTM is fine; the platform UTM is applied). Defaults to the first Ken link in `text`. */
  sourceUrl?: string;
  /** Post layout id (see strategy/layouts.ts). Default: numbered-points. */
  layout?: string;
  /** Extra specific notes, e.g. "your previous reply was cut off". */
  notes?: readonly string[];
  /** Qualitative statements from the report page that the text may keep or restate. */
  sourceNotes?: readonly { id: string; text: string; tier?: string }[];
  /** Supervisor corrections that must survive every validator rewrite. */
  supervisorInstructions?: string;
}

/** Resolves the one link the rewrite must keep, with the platform UTM applied. */
export function requiredLink(input: Pick<RewritePromptInput, 'text' | 'sourceUrl' | 'platform' | 'config'>): string | null {
  const hosts = input.config.sourcePolicy.kenResearchHosts;
  const base = input.sourceUrl ?? extractUrls(input.text).find((u) => isKenResearchUrl(u, hosts));
  if (!base) return null;
  const utm = input.config.utm[input.platform];
  return utm ? applyUtm(base, utm) : base;
}

function describeFact(f: Fact): string {
  const parts = [`${f.metric} = ${f.value} ${f.unit}`];
  if (f.currency) parts.push(`currency ${f.currency}`);
  if (f.period) parts.push(`period ${f.period}`);
  if (f.geography) parts.push(`geography ${f.geography}`);
  if (f.marketDefinition) parts.push(`market ${f.marketDefinition}`);
  if (f.sourceTier === 'government') parts.push(`source ${f.sourceName ?? 'a government body'} (government/regulatory: attribute it to that body in the same sentence, never to Ken Research)`);
  if (f.sourceTier === 'ken_research') parts.push(`source Ken Research report "${f.sourceName ?? f.sourceTitle}" (a different report than the one linked: attribute to Ken Research and state its scope)`);
  return `- [${f.id}] ${parts.join('; ')}`;
}

/**
 * Detail fields that are safe to show the model. Competitor details are never
 * echoed: naming a competitor in the prompt primes the model to use it.
 */
function safeDetail(i: ValidationIssue): string {
  if (!i.detail || i.code === 'COMPETITOR_MENTION') return '';
  const json = JSON.stringify(i.detail);
  return json.length > 400 ? ` (details: ${json.slice(0, 400)}...)` : ` (details: ${json})`;
}

function describeIssue(i: ValidationIssue): string {
  if (i.code === 'COMPETITOR_MENTION') {
    return '- [COMPETITOR_MENTION] The text mentions or links a competing research firm. Remove every mention and every link of any firm other than Ken Research; attribute only to Ken Research.';
  }
  const d = i.detail as { length?: unknown; max?: unknown; over?: unknown } | undefined;
  if (i.code === 'OVER_HARD_LIMIT' && typeof d?.length === 'number' && typeof d.max === 'number' && typeof d.over === 'number') {
    // Models routinely cut a few words and stay over. Name the amount, the target and the method.
    const aim = Math.floor(d.max * 0.85);
    return `- [OVER_HARD_LIMIT] The text is ${d.length} characters, which is ${d.over} over the hard cap of ${d.max}. Cut it to about ${aim} characters: delete whole sentences or whole paragraphs that repeat a point or add no new information, instead of trimming words. Keep the opening, the Ken Research link and the hashtags.`;
  }
  return `- [${i.code}] ${i.message}${safeDetail(i)}`;
}

export function buildRewritePrompt(input: RewritePromptInput): string {
  const { text, issues, facts, platform, config } = input;
  const limit = config.platformLimits[platform];
  const link = requiredLink(input);

  const caps: string[] = [];
  if (limit.hardMaxChars !== null) {
    caps.push(
      `HARD CAP: the final text must be at most ${limit.hardMaxChars} characters` +
        (limit.urlCountsAs !== null ? ` (every URL counts as ${limit.urlCountsAs} characters)` : '') +
        '. Never exceed it.',
    );
    if (limit.formatting.boldBrand || limit.formatting.boldFigures) {
      caps.push('The cap is measured on the FINAL text: every bold letter or digit counts as 2 characters and every blank line as 1, so keep your text clearly below the cap.');
    }
  }
  if (limit.targetMinChars !== null || limit.targetMaxChars !== null) {
    caps.push(`LENGTH (strict): the final text must be between ${limit.targetMinChars ?? 'any'} and ${limit.targetMaxChars ?? 'any'} characters including spaces, link and hashtags. Count before replying; if over, cut the least important insight.`);
  }
  if (limit.hashtags.max > 0) caps.push(`Use ${limit.hashtags.min} to ${limit.hashtags.max} hashtags.`);
  if (limit.requireTitle) caps.push('The first line must be a title written as a markdown H1 ("# Title").');
  const brand = config.brand.name;
  caps.push(`Name "${brand}" in a substantive source-backed finding in the body, preferably the first evidence sentence. A hashtag or report-link label alone does not count. Do not attribute official-source findings or your own advice to it.`);
  if (limit.formatting.boldBrand) caps.push(`Keep every mention of "${brand}" in double asterisks: **${brand}**.`);
  if (limit.formatting.boldFigures) caps.push('Keep every currency amount and percentage/CAGR figure, with its unit, in double asterisks, e.g. **USD 4.2 billion**, **7.2%**.');
  if (limit.formatting.boldFigures) caps.push('Years (for example **2025**) are bold too.');
  if (limit.formatting.selectiveBold) caps.push('Keep the rest plain; optionally bold ONE short key figure in addition to required brand emphasis. Do not bold every figure, year or keyword.');
  else if (limit.formatting.boldBrand || limit.formatting.boldFigures) caps.push('Bold nothing else.');
  else caps.push('Plain text only: no asterisks or markdown.');
  if (platform === 'x' || platform === 'tumblr') caps.push(layoutSection(config, platform)!);
  if (limit.formatting.layout === 'numbered_points') {
    if (platform === 'linkedin' || platform === 'facebook') {
      caps.push(layoutSection(config, platform, input.layout)!);
    } else {
      const layout = layoutById(input.layout);
      caps.push(
        `Keep the layout "${layout.label}": ${layout.steps.join(' ')} Then a closing question, a line ending with a colon followed by the link on its own line, an engagement question, then hashtags starting with #${brand.replace(/\s+/g, '')}. One blank line between blocks. ${layout.listRule}`,
        'Keep BOTH questions in those positions. The closing question asks about a strategic implication; the engagement question asks for a concrete experience, example or response. Give them different purposes, not two paraphrases of the same question.',
      );
    }
  }
  caps.push('No emoji and no em dashes.');

  const lines: string[] = [
    `You are revising a ${platform} draft for ${config.brand.name}. Fix ONLY the problems listed below and change nothing else.`,
    '',
    'PROBLEMS TO FIX:',
    ...issues.map(describeIssue),
    '',
    'RULES:',
    '- Keep every verified fact that is already in the text. Do not change a number, unit, period or geography.',
    '- Add NO new numbers, statistics, dates or factual claims. Use only the facts listed below.',
    '- Keep each figure\'s period clear. Figures in the same sentence may share ONE explicit geography when they all have the same scope. Keep differing country, regional and global scopes distinct.',
    '- Never mention, quote or link any other market research firm. Attribute only to ' + config.brand.name + '.',
    `- Do not use these characters: ${config.brand.bannedCharacters.join(' ')}`,
    `- Tone: ${config.brand.tone}. No exclamation marks, no emoji, no "we" or "our" about ${config.brand.name}.`,
    ...(link
      ? [`- Keep this ${config.brand.name} link EXACTLY ONCE, character for character, with nothing added or removed: ${link}`]
      : [`- Include the ${config.brand.name} report link exactly once.`]),
    ...caps.map((c) => `- ${c}`),
    '- Do not add commentary, explanations or notes about your changes.',
    '',
    'ALLOWED FACTS (the only numbers you may use):',
    ...(facts.length > 0 ? facts.map(describeFact) : ['- (none supplied: use no numbers at all)']),
    '',
    ...(input.sourceNotes && input.sourceNotes.length > 0
      ? [
          'SOURCE NOTES (statements from the Ken Research report that you may keep or restate; add nothing beyond them):',
          ...input.sourceNotes.filter((n) => n.tier !== 'other').map((n) => `- [${n.id}] ${n.text}`),
          '- Attribute only the facts and source notes to Ken Research, never your own interpretation or advice.',
          '',
          ...(input.sourceNotes.some((n) => n.tier === 'other')
            ? [
                'NEUTRAL BACKGROUND (general, number-free context; restate as plain neutral statements; never attribute it to Ken Research, never name a source, no "according to"):',
                ...input.sourceNotes.filter((n) => n.tier === 'other').map((n) => `- [${n.id}] ${n.text}`),
                '',
              ]
            : []),
        ]
      : []),
    ...(input.notes && input.notes.length > 0 ? ['NOTES:', ...input.notes.map((n) => `- ${n}`), ''] : []),
    ...(input.supervisorInstructions ? ['SUPERVISOR CORRECTIONS TO PRESERVE:', input.supervisorInstructions, 'Preserve these corrections while fixing the listed failures. Evidence, hard validation and the house format take precedence over any conflicting style suggestion.', ''] : []),
    'CURRENT TEXT:',
    '"""',
    text,
    '"""',
    '',
    outputFormatInstruction(),
  ];
  return lines.join('\n');
}
