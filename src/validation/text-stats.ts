/** Small, dependency-free text statistics used by the review checks. English-only heuristics. */

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** Report-link labels and hashtags are not substantive source attribution. */
export function attributionBody(text: string): string {
  const lines = text.split(/\r?\n/).map(line => line.replaceAll('⠀', '').trim()).filter(Boolean);
  const label = /^(?:(?:read|view|see|review|explore|access|download)\s+(?:the\s+)?)?(?:full\s+)?(?:Ken Research(?:['’]s)?\s+)?(?:report|research|analysis|outlook|market breakdown|source)(?:\s+(?:here|below))?\s*:?\s*$/i;
  return lines.filter((line, i) => {
    // A colon-ended line immediately introducing a standalone URL is a CTA.
    if (line.endsWith(':') && /^https?:\/\/\S+$/i.test(lines[i + 1] ?? '')) return false;
    return !label.test(line.replace(URL_RE, '').replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '').trim());
  }).map(line => line.replace(URL_RE, ' ').replace(/(^|\s)#[\p{L}\p{N}_]+/gu, ' ')).join('\n');
}

/** Straight apostrophes/quotes so phrase lists match curly-quote text. */
export function straighten(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

/** Prose only: no URLs, hashtags, markdown heading/list markers. */
export function proseOf(text: string): string {
  return straighten(text)
    .replace(URL_RE, ' ')
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function splitSentences(prose: string): string[] {
  return prose
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=["'(\[]?[\p{Lu}\p{N}])/u))
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

export function wordsOf(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) ?? [];
}

export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 1;
  if (w.length <= 3) return 1;
  let s = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = s.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export interface TextStats {
  words: number;
  sentences: number;
  avgSentenceWords: number;
  sentenceLengths: number[];
  fleschReadingEase: number;
  sentenceLengthCv: number;
}

export function textStats(text: string): TextStats {
  const prose = proseOf(text);
  const sentences = splitSentences(prose);
  const sentenceLengths = sentences.map((s) => wordsOf(s).length);
  const allWords = wordsOf(prose);
  const nWords = allWords.length;
  const nSent = Math.max(1, sentences.length);
  const syllables = allWords.reduce((sum, w) => sum + countSyllables(w), 0);
  const avg = nWords / nSent;
  const fre = nWords === 0 ? 0 : 206.835 - 1.015 * avg - 84.6 * (syllables / nWords);
  const mean = sentenceLengths.length ? sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length : 0;
  const variance = sentenceLengths.length
    ? sentenceLengths.reduce((a, b) => a + (b - mean) ** 2, 0) / sentenceLengths.length
    : 0;
  return {
    words: nWords,
    sentences: sentences.length,
    avgSentenceWords: avg,
    sentenceLengths,
    fleschReadingEase: fre,
    sentenceLengthCv: mean === 0 ? 0 : Math.sqrt(variance) / mean,
  };
}
