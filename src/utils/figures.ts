/**
 * Locates the figures that must be bold on bold platforms: currency amounts and
 * percentage / CAGR values. Years, counts and ordinary numbers are not figures.
 * Runs on PLAIN text (see bold.ts); URLs are excluded by the caller.
 */

const CURRENCY = String.raw`(?:USD|US\$|EUR|GBP|INR|ZAR|AUD|CAD|\$|€|£)`;
const CODE = String.raw`(?:USD|EUR|GBP|INR|ZAR|AUD|CAD)`;
const SCALE = String.raw`(?:billion|million|trillion|bn|mn)`;
const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;

const FIGURE_SOURCE = [
  // USD 4.2 billion | $146.5M | US$ 3,200 | EUR 5 bn
  String.raw`${CURRENCY}\s?${NUMBER}(?:\s?(?:${SCALE}|m|b|k)\b)?`,
  // 146.5 USD million
  String.raw`${NUMBER}\s?${CODE}\s?${SCALE}\b`,
  // 4.2 billion | 222.3 Mn USD
  String.raw`${NUMBER}\s?${SCALE}\b(?:\s?${CODE}\b)?`,
  // 7.2% | 7.20 percent | 3 per cent
  String.raw`${NUMBER}\s?(?:%|percent\b|per cent\b)`,
  // 2025, 2031 (years are bold too in the reference post; "2025-2031" bolds both years)
  String.raw`\b(?:19|20)\d{2}\b`,
].join('|');

export interface FigureMatch {
  text: string;
  start: number;
  end: number;
}

export function findFigures(plain: string): FigureMatch[] {
  const re = new RegExp(FIGURE_SOURCE, 'gi');
  const out: FigureMatch[] = [];
  for (const m of plain.matchAll(re)) {
    const start = m.index ?? 0;
    out.push({ text: m[0], start, end: start + m[0].length });
  }
  return out;
}

/** Same pattern as a source string, for fixers that need to build their own RegExp. */
export const FIGURE_PATTERN = FIGURE_SOURCE;
