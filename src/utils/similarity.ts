/**
 * Cheap, dependency-free near-duplicate measurement: word shingles + Jaccard.
 * Thresholds are NOT fixed here; they must be calibrated on labelled examples
 * (precision/recall) before being relied on.
 */

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Set of n-word shingles. Texts shorter than n words yield one shingle of all their words. */
export function shingles(text: string, n = 3): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  if (w.length === 0) return out;
  if (w.length < n) {
    out.add(w.join(' '));
    return out;
  }
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Shingle-Jaccard similarity of two texts, 0..1. */
export function textSimilarity(a: string, b: string, n = 3): number {
  return jaccard(shingles(a, n), shingles(b, n));
}

/** Highest similarity of `text` against each candidate, with the index of the closest one. */
export function mostSimilar(text: string, candidates: readonly string[], n = 3): { score: number; index: number } {
  const target = shingles(text, n);
  let best = { score: 0, index: -1 };
  candidates.forEach((candidate, index) => {
    const score = jaccard(target, shingles(candidate, n));
    if (score > best.score) best = { score, index };
  });
  return best;
}
