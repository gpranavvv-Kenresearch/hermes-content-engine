import { competitors as defaultCompetitors } from '../config/competitors.config.js';
import type { CompetitorEntry, SourceNote } from '../schemas/index.js';
import { jaccard, shingles } from '../utils/similarity.js';
import { buildCompetitorDetector } from '../validation/competitors.js';
import { splitSentences } from './fact-extractor.js';

/**
 * Picks qualitative statements from a report page to give the model real material (drivers,
 * challenges, competitive landscape) so it does not have to invent context around two or three
 * numbers. Heuristic, deterministic, no model involved.
 *
 * A sentence is kept only if it reads like prose and is safe to restate:
 *  - 80 to 320 characters, ends with a full stop, starts with a capital;
 *  - no figures (digits other than years) and no table residue ("$", "Mn +", columns of values);
 *  - no URL and no mention of a competitor research firm;
 *  - not a near-duplicate of a sentence already kept.
 * Remaining sentences are scored by topical vocabulary and the best `max` are returned in page order.
 */

export interface ExtractNotesInput {
  text: string;
  url: string;
  /** Maximum number of notes. Default 12. */
  max?: number;
  competitors?: readonly CompetitorEntry[];
}

const TOPIC_WORDS = [
  'growth', 'driver', 'supported', 'demand', 'adoption', 'monetiz', 'subscription', 'competit', 'concentrat',
  'fragment', 'leader', 'leading', 'opportunit', 'challenge', 'barrier', 'trust', 'verification', 'mobile',
  'digital', 'regulat', 'complian', 'consent', 'pricing', 'recurring', 'vertical', 'largest', 'ranks', 'expand',
  'advantage', 'depends', 'benefit', 'outlook', 'platform', 'consumer', 'customer', 'employer', 'investment',
];

const BOILERPLATE_RE =
  /\b(cookie|privacy policy|terms of|subscribe|newsletter|download|request (?:a )?(?:sample|quote|demo)|contact us|click|login|sign in|copyright|all rights reserved|what you'll gain|pages of insights|our approach)\b/i;

// Section blurbs that describe the report itself rather than state a finding.
const META_RE =
  /^(?:this (?:section|chapter|report|analysis)|comprehensive analysis|the report (?:provides|covers|includes|presents)|this section evaluates|in this (?:section|chapter))\b/i;

function hasFigure(sentence: string): boolean {
  // years are fine ("in 2025"); any other digit means a figure, which belongs in a Fact, not a note
  return /\d/.test(sentence.replace(/\b(?:19|20)\d{2}\b/g, ''));
}

function looksLikeProse(sentence: string): boolean {
  if (sentence.length < 80 || sentence.length > 320) return false;
  if (!/^[A-Z]/.test(sentence) || !/[.]$/.test(sentence)) return false;
  if (sentence.split(/\s+/).length < 12) return false;
  if (/[$€£]|\bMn\b|\bBn\b|%|https?:\/\//.test(sentence)) return false;
  if (BOILERPLATE_RE.test(sentence) || META_RE.test(sentence)) return false;
  return true;
}

// Statements about who competes and how concentrated the market is carry the most weight in a
// decision-maker post (they are the "so what" of a market size).
const STRUCTURE_WORDS = ['concentrat', 'fragment', 'dominan', 'incumbent', 'largest', 'ranks', 'leading'];

function score(sentence: string): number {
  const lower = sentence.toLowerCase();
  const hits = TOPIC_WORDS.filter((w) => lower.includes(w)).length;
  const structure = STRUCTURE_WORDS.some((w) => lower.includes(w)) ? 2 : 0;
  return hits + structure + Math.min(1, sentence.length / 320);
}

export function extractNotes(input: ExtractNotesInput): SourceNote[] {
  const max = input.max ?? 12;
  const detector = buildCompetitorDetector(input.competitors ?? defaultCompetitors);

  const candidates: Array<{ text: string; index: number; score: number; shingle: Set<string> }> = [];
  splitSentences(input.text).forEach((raw, index) => {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!looksLikeProse(text) || hasFigure(text)) return;
    if (detector.find(text).length > 0) return;
    const shingle = shingles(text, 3);
    if (candidates.some((c) => jaccard(c.shingle, shingle) > 0.7)) return;
    candidates.push({ text, index, score: score(text), shingle });
  });

  const best = [...candidates]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index);
  return best.map((c, i) => ({ id: `N${i + 1}`, text: c.text, sourceUrl: input.url }));
}
