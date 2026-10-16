import type { ValidationIssue } from '../schemas/index.js';
import { sha256Hex } from '../utils/hash.js';
import { normalizeForMatch } from '../utils/normalize.js';
import { jaccard, shingles } from '../utils/similarity.js';

/**
 * UNCALIBRATED DEFAULTS. These two numbers are starting guesses, not measured
 * values. Use calibrateThreshold() on labelled pairs of real drafts before
 * trusting them, and keep the two thresholds separate: "exact" is a hard fail,
 * "near" only asks for review.
 */
export const UNCALIBRATED_EXACT_DUPLICATE_THRESHOLD = 0.98;
export const UNCALIBRATED_NEAR_DUPLICATE_THRESHOLD = 0.7;

export interface DedupThresholds {
  exact: number;
  near: number;
}

export const DEFAULT_DEDUP_THRESHOLDS: DedupThresholds = {
  exact: UNCALIBRATED_EXACT_DUPLICATE_THRESHOLD,
  near: UNCALIBRATED_NEAR_DUPLICATE_THRESHOLD,
};

/**
 * Hash of the text with URLs removed and everything normalized (case,
 * punctuation, whitespace, diacritics). Two posts that differ only in UTM,
 * spacing or punctuation hash the same.
 */
export function normalizedHash(text: string): string {
  const noUrls = text.replace(/https?:\/\/\S+/gi, ' ');
  return sha256Hex(normalizeForMatch(noUrls));
}

export interface DuplicateMatch {
  index: number;
  score: number;
  exactHash: boolean;
}

export function bestDuplicateMatch(text: string, recentTexts: readonly string[], n = 3): DuplicateMatch | null {
  if (recentTexts.length === 0) return null;
  const hash = normalizedHash(text);
  const target = shingles(text, n);
  let best: DuplicateMatch | null = null;
  recentTexts.forEach((other, index) => {
    const exactHash = normalizedHash(other) === hash;
    const score = exactHash ? 1 : jaccard(target, shingles(other, n));
    if (best === null || score > best.score) best = { index, score, exactHash };
  });
  return best;
}

export function checkDuplicates(
  text: string,
  recentTexts: readonly string[],
  thresholds: DedupThresholds = DEFAULT_DEDUP_THRESHOLDS,
): ValidationIssue[] {
  const best = bestDuplicateMatch(text, recentTexts);
  if (!best) return [];
  const detail = { closestIndex: best.index, similarity: Math.round(best.score * 1000) / 1000, thresholds, calibrated: false };
  if (best.exactHash || best.score >= thresholds.exact) {
    return [{ code: 'EXACT_DUPLICATE', severity: 'hard_fail', message: 'Text is an exact (or near-identical) copy of a recent post.', detail }];
  }
  if (best.score >= thresholds.near) {
    return [{ code: 'NEAR_DUPLICATE', severity: 'review', message: 'Text is very similar to a recent post.', detail }];
  }
  return [];
}

// --- calibration ---------------------------------------------------------------

export interface LabelledPair {
  a: string;
  b: string;
  /** Human judgement: would you call these the same post? */
  duplicate: boolean;
}

export interface ThresholdStats {
  threshold: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  /** null when nothing was predicted positive. */
  precision: number | null;
  /** null when there are no positive labels. */
  recall: number | null;
}

export const DEFAULT_CANDIDATE_THRESHOLDS: readonly number[] = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98];

/**
 * For each candidate threshold, reports precision and recall of "similarity >=
 * threshold" against human labels, so the real value can be picked from data.
 */
export function calibrateThreshold(
  pairs: readonly LabelledPair[],
  candidates: readonly number[] = DEFAULT_CANDIDATE_THRESHOLDS,
): ThresholdStats[] {
  const scored = pairs.map((p) => ({ score: jaccard(shingles(p.a, 3), shingles(p.b, 3)), duplicate: p.duplicate }));
  return [...candidates]
    .sort((x, y) => x - y)
    .map((threshold) => {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      let tn = 0;
      for (const s of scored) {
        const predicted = s.score >= threshold;
        if (predicted && s.duplicate) tp++;
        else if (predicted && !s.duplicate) fp++;
        else if (!predicted && s.duplicate) fn++;
        else tn++;
      }
      return {
        threshold,
        truePositives: tp,
        falsePositives: fp,
        falseNegatives: fn,
        trueNegatives: tn,
        precision: tp + fp === 0 ? null : tp / (tp + fp),
        recall: tp + fn === 0 ? null : tp / (tp + fn),
      };
    });
}
