import type { PlatformId } from '../../schemas/index.js';
import { payloadLength } from '../../utils/text.js';
import { proseOf, splitSentences, straighten, textStats, wordsOf } from '../text-stats.js';
import {
  AI_TELL_PATTERNS,
  AI_TELL_PHRASES,
  GENERIC_PROMO_PHRASES,
  WEAK_EVIDENCE_PATTERNS,
} from './ai-tells.js';
import { issue, type Check } from './context.js';

/**
 * Review-severity checks. None of these blocks publication on its own; they
 * feed a rewrite or a human glance. Every number below is an UNCALIBRATED
 * heuristic default and is documented in docs/validation.md.
 */

// --- shared helpers ----------------------------------------------------------

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Phrase matcher with letter/digit boundaries; case-insensitive; straight apostrophes. */
export function findPhrases(text: string, phrases: readonly string[]): string[] {
  const hay = straighten(text);
  const hits: string[] = [];
  for (const phrase of phrases) {
    const p = straighten(phrase);
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p)}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(hay)) hits.push(phrase);
  }
  return hits;
}

/** Hashtags that count: "#1" and "#2024" are ranks/numbers, not tags. */
export function countRealHashtags(text: string): number {
  return (text.match(/(^|\s)#\p{L}[\p{L}\p{N}_]*/gu) ?? []).length;
}

// --- length ------------------------------------------------------------------

export const checkTargetBand: Check = (text, ctx) => {
  const { targetMinChars: min, targetMaxChars: max } = ctx.limit;
  const length = payloadLength(text, ctx.limit);
  if (min !== null && length < min) {
    return [issue('BELOW_TARGET_BAND', 'review', `Length ${length} is below the target minimum ${min}.`, { length, min })];
  }
  if (max !== null && length > max) {
    return [issue('ABOVE_TARGET_BAND', 'review', `Length ${length} is above the target maximum ${max}.`, { length, max })];
  }
  return [];
};

/**
 * Minimum plausible length (characters of prose, URLs and hashtags excluded)
 * for a finished piece. REPLACES the legacy "length < 100 means refusal" rule:
 * a short text is suspicious, not proof of a refusal. UNCALIBRATED.
 */
export const MIN_SENSIBLE_CHARS: Record<PlatformId, number> = {
  x: 40,
  facebook: 400,
  linkedin: 400,
  tumblr: 60,
  instagram: 60,
  mastodon: 40,
  blog: 1500,
};

export const checkSuspiciouslyShort: Check = (text, ctx) => {
  const length = proseOf(text).length;
  const min = MIN_SENSIBLE_CHARS[ctx.platform];
  return length < min
    ? [issue('SUSPICIOUSLY_SHORT', 'review', `Only ${length} characters of prose; ${ctx.platform} content is normally at least ${min}.`, { length, min })]
    : [];
};

// --- hashtags ----------------------------------------------------------------

export const checkHashtagCount: Check = (text, ctx) => {
  const { min, max } = ctx.limit.hashtags;
  const count = countRealHashtags(text);
  if (count < min || count > max) {
    return [issue('HASHTAG_COUNT', 'review', `${count} hashtags; ${ctx.platform} expects ${min} to ${max}.`, { count, min, max })];
  }
  return [];
};

// --- banned wording ----------------------------------------------------------

export const checkBannedPhrase: Check = (text, ctx) => {
  const hits = findPhrases(text, ctx.config.brand.bannedPhrases);
  return hits.length > 0 ? [issue('BANNED_PHRASE', 'review', 'Text uses phrases the brand bans.', { phrases: hits })] : [];
};

export const checkBannedPromoWord: Check = (text, ctx) => {
  const hits = findPhrases(text, ctx.config.brand.bannedPromoWords);
  return hits.length > 0 ? [issue('BANNED_PROMO_WORD', 'review', 'Text uses hype words the brand bans.', { words: hits })] : [];
};

export const checkAiTell: Check = (text, ctx) => {
  const hay = straighten(text);
  const banned = findPhrases(text, ctx.config.brand.bannedPhrases).map((p) => straighten(p).toLowerCase());
  const hits: string[] = [];
  for (const phrase of findPhrases(text, AI_TELL_PHRASES)) hits.push(phrase);
  for (const p of AI_TELL_PATTERNS) {
    const m = hay.match(p.re);
    if (m) hits.push(p.id);
  }
  // Do not double-report what BANNED_PHRASE already covers.
  const fresh = hits.filter((h) => !banned.some((b) => b.includes(h.toLowerCase()) || h.toLowerCase().includes(b)));
  return fresh.length > 0 ? [issue('AI_TELL', 'review', 'Text contains stock phrasing typical of generated copy.', { hits: fresh })] : [];
};

// --- repetition --------------------------------------------------------------

const NGRAM_N = 4;
const NGRAM_MIN_REPEATS = 3;
const OPENER_MIN_REPEATS = 3;
const OPENER_MIN_SENTENCES = 5;

export const checkRepetitivePhrasing: Check = (text, ctx) => {
  const prose = proseOf(text).toLowerCase();
  const brand = ctx.config.brand.name.toLowerCase();
  const words = wordsOf(prose.split(brand).join(' '));
  const problems: Record<string, unknown> = {};

  const grams = new Map<string, number>();
  for (let i = 0; i + NGRAM_N <= words.length; i++) {
    const g = words.slice(i, i + NGRAM_N).join(' ');
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  const repeated = [...grams.entries()].filter(([, c]) => c >= NGRAM_MIN_REPEATS).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (repeated.length > 0) problems.ngrams = repeated.slice(0, 5).map(([g, c]) => ({ phrase: g, count: c }));

  const sentences = splitSentences(proseOf(text));
  if (sentences.length >= OPENER_MIN_SENTENCES) {
    const openers = new Map<string, number>();
    for (const s of sentences) {
      const lower = s.toLowerCase();
      if (lower.startsWith(brand)) continue; // attribution openers are expected
      const opener = wordsOf(lower).slice(0, 2).join(' ');
      if (opener) openers.set(opener, (openers.get(opener) ?? 0) + 1);
    }
    const rep = [...openers.entries()].filter(([, c]) => c >= OPENER_MIN_REPEATS).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (rep.length > 0) problems.openers = rep.slice(0, 5).map(([o, c]) => ({ opener: o, count: c }));
  }

  return Object.keys(problems).length > 0
    ? [issue('REPETITIVE_PHRASING', 'review', 'Repeated phrases or sentence openers.', problems)]
    : [];
};

// --- evidence and promo ------------------------------------------------------

export const checkWeakEvidenceWording: Check = (text, ctx) => {
  const brand = ctx.config.brand.name.toLowerCase();
  const hits: string[] = [];
  for (const sentence of splitSentences(straighten(text).replace(/(^|\s)#[\p{L}\p{N}_]+/gu, ' '))) {
    const sourced = /https?:\/\//i.test(sentence) || sentence.toLowerCase().includes(brand);
    if (sourced) continue;
    for (const p of WEAK_EVIDENCE_PATTERNS) if (p.re.test(sentence)) hits.push(p.id);
  }
  return hits.length > 0
    ? [issue('WEAK_EVIDENCE_WORDING', 'review', 'Vague attribution with no named source.', { hits: [...new Set(hits)] })]
    : [];
};

export const checkGenericPromotional: Check = (text) => {
  const hits = findPhrases(text, GENERIC_PROMO_PHRASES);
  return hits.length > 0 ? [issue('GENERIC_PROMOTIONAL', 'review', 'Generic sales boilerplate in an analyst-voice text.', { phrases: hits })] : [];
};

// --- readability -------------------------------------------------------------

/**
 * Bands for senior B2B authoritative text (UNCALIBRATED; revisit with real
 * approved posts). Only evaluated once there are enough words to be meaningful.
 *
 *  - Flesch reading ease 20..60. Below 20 is dense academic prose that
 *    executives skim past; above 60 is chatty consumer copy that undercuts the
 *    analyst voice. (Typical business-analysis prose scores roughly 25 to 50.)
 *  - Average sentence length 10..28 words.
 */
export const READABILITY_BANDS = {
  minWords: 40,
  minSentences: 2,
  fleschMin: 20,
  fleschMax: 60,
  avgSentenceMin: 10,
  avgSentenceMax: 28,
} as const;

export const checkReadability: Check = (text) => {
  const s = textStats(text);
  const b = READABILITY_BANDS;
  if (s.words < b.minWords || s.sentences < b.minSentences) return [];
  const reasons: string[] = [];
  if (s.fleschReadingEase < b.fleschMin) reasons.push('too_dense');
  if (s.fleschReadingEase > b.fleschMax) reasons.push('too_simple');
  if (s.avgSentenceWords > b.avgSentenceMax) reasons.push('sentences_too_long');
  if (s.avgSentenceWords < b.avgSentenceMin) reasons.push('sentences_too_choppy');
  return reasons.length > 0
    ? [
        issue('READABILITY', 'review', 'Readability is outside the band for senior B2B text.', {
          reasons,
          fleschReadingEase: Math.round(s.fleschReadingEase * 10) / 10,
          avgSentenceWords: Math.round(s.avgSentenceWords * 10) / 10,
        }),
      ]
    : [];
};

/** Coefficient of variation of sentence length below this reads as monotone. UNCALIBRATED. */
export const SENTENCE_VARIANCE = { minSentences: 6, minCv: 0.3 } as const;

export const checkLowSentenceVariance: Check = (text) => {
  const s = textStats(text);
  if (s.sentences < SENTENCE_VARIANCE.minSentences) return [];
  return s.sentenceLengthCv < SENTENCE_VARIANCE.minCv
    ? [issue('LOW_SENTENCE_VARIANCE', 'review', 'Sentences are almost all the same length.', { cv: Math.round(s.sentenceLengthCv * 100) / 100, sentences: s.sentences })]
    : [];
};

// --- tone --------------------------------------------------------------------

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const EMOJI_IGNORE = new Set(['©', '®', '™']);
const FIRST_PERSON_RE = /\b(we|our|ours|we're|we've|we'll|we'd)\b/gi;

export const checkTone: Check = (text) => {
  const noUrls = straighten(text).replace(/https?:\/\/\S+/gi, ' ');
  const reasons: string[] = [];
  const detail: Record<string, unknown> = {};

  const bangs = (noUrls.match(/!/g) ?? []).length;
  if (bangs > 0) {
    reasons.push('exclamation');
    detail.exclamations = bangs;
  }
  const emojis = (noUrls.match(EMOJI_RE) ?? []).filter((e) => !EMOJI_IGNORE.has(e));
  if (emojis.length > 0) {
    reasons.push('emoji');
    detail.emojis = emojis.length;
  }
  // Quoted speech may legitimately say "we"; ignore double-quoted spans.
  const unquoted = noUrls.replace(/"[^"\n]*"/g, ' ');
  const firstPerson = unquoted.match(FIRST_PERSON_RE) ?? [];
  if (firstPerson.length > 0) {
    reasons.push('first_person_we_our');
    detail.firstPerson = [...new Set(firstPerson.map((w) => w.toLowerCase()))];
  }
  return reasons.length > 0
    ? [issue('TONE', 'review', 'Tone is off-brand (exclamations, emoji, or "we/our" about Ken Research).', { reasons, ...detail })]
    : [];
};

/** Deterministic order. */
export const reviewChecks: Check[] = [
  checkTargetBand,
  checkSuspiciouslyShort,
  checkHashtagCount,
  checkBannedPhrase,
  checkBannedPromoWord,
  checkAiTell,
  checkRepetitivePhrasing,
  checkWeakEvidenceWording,
  checkGenericPromotional,
  checkReadability,
  checkLowSentenceVariance,
  checkTone,
];
