import type { ValidationIssue } from '../../schemas/index.js';
import { extractUrls, payloadLength } from '../../utils/text.js';
import { findUtmProblems, isKenResearchUrl } from '../../utils/utm.js';
import { issue, type Check } from './context.js';
import { modelArtifactChecks } from './model-artifacts.js';

export const checkCompetitorMention: Check = (text, ctx) => {
  const matches = ctx.detector.find(text);
  if (matches.length === 0) return [];
  return [
    issue('COMPETITOR_MENTION', 'hard_fail', 'A competitor research firm is mentioned or linked.', {
      competitors: [...new Set(matches.map((m) => m.competitor))],
      matched: [...new Set(matches.map((m) => m.matched))],
    }),
  ];
};

export const checkBannedCharacter: Check = (text, ctx) => {
  const found = ctx.config.brand.bannedCharacters.filter((c) => text.includes(c));
  return found.length > 0
    ? [
        issue('BANNED_CHARACTER', 'hard_fail', 'Text contains characters the brand forbids (em/en dash).', {
          characters: found.map((c) => ({
            codePoint: `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`,
            count: text.split(c).length - 1,
          })),
        }),
      ]
    : [];
};

/** Emoji, pictograph and dingbat symbols (the brand voice is plain text). Arrows and © ® ™ are not included. */
export const BANNED_EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}\u{FE0F}\u{20E3}\u{200D}]/gu;

export const checkEmoji: Check = (text) => {
  const found = text.match(BANNED_EMOJI_RE);
  return found
    ? [issue('BANNED_EMOJI', 'hard_fail', 'Text contains emoji or pictograph symbols; use plain text only.', { count: found.length })]
    : [];
};

export const checkOverHardLimit: Check = (text, ctx) => {
  const max = ctx.limit.hardMaxChars;
  if (max === null) return [];
  const length = payloadLength(ctx.finalText ?? text, ctx.limit);
  return length > max
    ? [issue('OVER_HARD_LIMIT', 'hard_fail', `Payload is ${length} characters; the hard cap on ${ctx.platform} is ${max}.`, { length, max, over: length - max })]
    : [];
};

export const checkSourceLink: Check = (text, ctx) => {
  if (!ctx.limit.requireSourceLink) return [];
  const has = extractUrls(text).some((u) => isKenResearchUrl(u, ctx.config.sourcePolicy.kenResearchHosts));
  return has ? [] : [issue('MISSING_SOURCE_LINK', 'hard_fail', 'No Ken Research source link found.')];
};

const UTM_CODE = { missing_utm: 'MISSING_UTM', duplicate_utm: 'DUPLICATE_UTM', wrong_utm: 'WRONG_UTM' } as const;
const UTM_MESSAGE = {
  missing_utm: 'A Ken Research link has no UTM parameters.',
  duplicate_utm: 'A Ken Research link repeats a UTM parameter.',
  wrong_utm: 'A Ken Research link has UTM parameters that are not the approved set.',
} as const;

export const checkUtm: Check = (text, ctx) => {
  const entry = ctx.config.utm[ctx.platform];
  if (!entry) return [];
  const problems = findUtmProblems(text, entry, ctx.config.sourcePolicy.kenResearchHosts);
  const out: ValidationIssue[] = [];
  for (const kind of ['missing_utm', 'duplicate_utm', 'wrong_utm'] as const) {
    const urls = problems.filter((p) => p.kind === kind).map((p) => p.url);
    if (urls.length > 0) out.push(issue(UTM_CODE[kind], 'hard_fail', UTM_MESSAGE[kind], { urls }));
  }
  return out;
};

export interface PlaceholderPattern {
  id: string;
  re: RegExp;
}

/** Fixes the legacy gap where only "[... NEEDED]" was caught. */
export const PLACEHOLDER_PATTERNS: PlaceholderPattern[] = [
  { id: 'bracket_needed', re: /\[[^\]\n]{0,80}\bNEEDED\b[^\]\n]{0,40}\]/i },
  { id: 'bracket_insert', re: /\[\s*insert\b[^\]\n]{0,80}\]/i },
  { id: 'mustache', re: /\{\{[^}\n]*\}\}/ },
  { id: 'todo', re: /\bTODO\b/ },
  { id: 'tbd', re: /\bTBD\b/ },
  { id: 'lorem_ipsum', re: /\blorem ipsum\b/i },
  { id: 'xxx', re: /\bXXX+\b/ },
  { id: 'figure_omitted', re: /\[\s*figure omitted\s*\]/i },
  { id: 'data_needed', re: /\[\s*data needed\s*\]/i },
];

export const checkPlaceholder: Check = (text) => {
  const hits = PLACEHOLDER_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.id);
  return hits.length > 0 ? [issue('PLACEHOLDER', 'hard_fail', 'Unfilled placeholder text found.', { patterns: hits })] : [];
};

/** A blog needs a markdown H1 ("# Title") or an explicit "Title:" line as its first non-empty line. */
export const checkTitle: Check = (text, ctx) => {
  if (!ctx.limit.requireTitle) return [];
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const ok = /^#\s+\S/.test(first) || /^title\s*:\s*\S/i.test(first);
  return ok ? [] : [issue('MISSING_TITLE', 'hard_fail', 'A blog post must start with a title line ("# Title").')];
};

/** Deterministic order. */
export const hardFailChecks: Check[] = [
  checkCompetitorMention,
  checkBannedCharacter,
  checkEmoji,
  checkOverHardLimit,
  checkSourceLink,
  checkUtm,
  checkPlaceholder,
  checkTitle,
  ...modelArtifactChecks,
];
