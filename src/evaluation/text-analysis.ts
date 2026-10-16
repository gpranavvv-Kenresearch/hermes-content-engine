import { JSDOM } from 'jsdom';

/** Plain-text helpers shared by the scoring dimensions. All pure and deterministic. */

export interface Heading {
  level: number;
  text: string;
}

export interface ParsedStructure {
  headings: Heading[];
  /** Body paragraphs in document order (no headings, no list items). */
  paragraphs: string[];
  listItemCount: number;
  tableCount: number;
  h1Count: number;
}

/** Removes HTML tags, markdown syntax and URLs, leaving readable prose. */
export function stripMarkup(input: string): string {
  return input
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*\|?[-:| ]{3,}\|?\s*$/gm, ' ')
    .replace(/[*_`>|~]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function words(plain: string): string[] {
  return plain.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}

export function wordCount(text: string): number {
  return words(text).length;
}

export function splitSentences(plain: string): string[] {
  return plain
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/** Vowel-group syllable heuristic (English). Always >= 1 for a non-empty word. */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 1;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export interface FleschResult {
  readingEase: number;
  words: number;
  sentences: number;
  syllables: number;
  avgSentenceLength: number;
  avgSyllablesPerWord: number;
}

/** Flesch (1948) Reading Ease: 206.835 - 1.015 (words/sentences) - 84.6 (syllables/words). */
export function fleschReadingEase(plain: string): FleschResult | null {
  const w = words(plain);
  const sentences = splitSentences(plain).length;
  if (w.length === 0 || sentences === 0) return null;
  const syllables = w.reduce((n, word) => n + countSyllables(word), 0);
  const avgSentenceLength = w.length / sentences;
  const avgSyllablesPerWord = syllables / w.length;
  const readingEase = 206.835 - 1.015 * avgSentenceLength - 84.6 * avgSyllablesPerWord;
  return { readingEase, words: w.length, sentences, syllables, avgSentenceLength, avgSyllablesPerWord };
}

/** True when the text contains at least one digit. */
export function hasNumber(text: string): boolean {
  return /\d/.test(text);
}

const NUMERIC_CLAIM_RE =
  /(?:[$€£₹]\s?\d[\d,]*(?:\.\d+)?)|(?:\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|billion\b|million\b|trillion\b|thousand\b|bn\b|mn\b|usd\b|cagr\b))|(?:\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b)|(?:\b\d+\.\d+\b)/gi;

/** Figures that look like material numeric claims (%, currency, scale words, decimals, 1,000s). Bare years are ignored. */
export function findNumericFigures(plain: string): string[] {
  return plain.match(NUMERIC_CLAIM_RE) ?? [];
}

function mdParse(text: string): ParsedStructure {
  const headings: Heading[] = [];
  const paragraphs: string[] = [];
  let listItemCount = 0;
  let tableCount = 0;
  let inTable = false;
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length > 0) paragraphs.push(stripMarkup(buf.join(' ')));
    buf = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (h) {
      flush();
      inTable = false;
      headings.push({ level: h[1]!.length, text: stripMarkup(h[2]!) });
      continue;
    }
    if (line === '') {
      flush();
      inTable = false;
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      flush();
      if (!inTable) tableCount++;
      inTable = true;
      continue;
    }
    if (/^([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      listItemCount++;
      continue;
    }
    buf.push(line);
  }
  flush();
  return {
    headings,
    paragraphs: paragraphs.filter((p) => p.length > 0),
    listItemCount,
    tableCount,
    h1Count: headings.filter((x) => x.level === 1).length,
  };
}

function htmlParse(html: string): ParsedStructure {
  const doc = new JSDOM(html).window.document;
  for (const el of Array.from(doc.querySelectorAll('script, style, noscript, template'))) el.remove();
  const headings: Heading[] = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => ({
    level: Number(h.tagName.slice(1)),
    text: (h.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }));
  const paragraphs = Array.from(doc.querySelectorAll('p'))
    .map((p) => (p.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
  return {
    headings,
    paragraphs,
    listItemCount: doc.querySelectorAll('li').length,
    tableCount: doc.querySelectorAll('table').length,
    h1Count: headings.filter((x) => x.level === 1).length,
  };
}

/** Parses headings/paragraphs/lists from HTML when provided, otherwise from markdown-ish text. */
export function parseStructure(text: string, html?: string): ParsedStructure {
  return html !== undefined && html.trim() !== '' ? htmlParse(html) : mdParse(text);
}

/** Heading-level skips such as H2 -> H4 (claude-blog analyze_headings rule). */
export function hierarchySkips(headings: readonly Heading[]): Array<{ from: number; to: number; text: string }> {
  const skips: Array<{ from: number; to: number; text: string }> = [];
  let prev = 0;
  for (const h of headings) {
    if (prev > 0 && h.level > prev + 1) skips.push({ from: prev, to: h.level, text: h.text });
    prev = h.level;
  }
  return skips;
}
