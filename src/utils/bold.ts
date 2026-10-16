/**
 * Bold text for platforms that do not render markdown (Facebook, LinkedIn).
 * The model writes **double-asterisk** markdown; at the end it is converted to
 * Unicode "Mathematical Bold" letters and digits, which display as bold in any
 * plain-text field. Punctuation and spaces have no bold form and stay as they are.
 *
 * Validation must NOT run on the converted text directly: bold digits and
 * letters are different code points, so number regexes and name matchers would
 * not see them. `boldFlags` gives the plain text plus a per-character bold flag
 * so validators read plain text while formatting checks read the flags.
 *
 * Accessibility note: screen readers may read these characters oddly.
 */

const UPPER_START = 0x1d400; // MATHEMATICAL BOLD CAPITAL A
const LOWER_START = 0x1d41a; // MATHEMATICAL BOLD SMALL A
const DIGIT_START = 0x1d7ce; // MATHEMATICAL BOLD DIGIT ZERO

function boldCodePoint(ch: string): string {
  const cp = ch.codePointAt(0)!;
  if (cp >= 65 && cp <= 90) return String.fromCodePoint(UPPER_START + cp - 65);
  if (cp >= 97 && cp <= 122) return String.fromCodePoint(LOWER_START + cp - 97);
  if (cp >= 48 && cp <= 57) return String.fromCodePoint(DIGIT_START + cp - 48);
  return ch;
}

/** The ASCII letter/digit a Mathematical Bold code point stands for, or undefined. */
function asciiOfBold(ch: string): string | undefined {
  const cp = ch.codePointAt(0)!;
  if (cp >= UPPER_START && cp < UPPER_START + 26) return String.fromCharCode(65 + cp - UPPER_START);
  if (cp >= LOWER_START && cp < LOWER_START + 26) return String.fromCharCode(97 + cp - LOWER_START);
  if (cp >= DIGIT_START && cp < DIGIT_START + 10) return String.fromCharCode(48 + cp - DIGIT_START);
  return undefined;
}

/** ASCII letters and digits become Mathematical Bold; everything else is unchanged. */
export function toUnicodeBold(text: string): string {
  return Array.from(text, boldCodePoint).join('');
}

/** Mathematical Bold letters and digits become plain ASCII; everything else is unchanged. */
export function fromUnicodeBold(text: string): string {
  return Array.from(text, (ch) => asciiOfBold(ch) ?? ch).join('');
}

export function hasUnicodeBold(text: string): boolean {
  for (const ch of text) if (asciiOfBold(ch) !== undefined) return true;
  return false;
}

const MD_BOLD_RE = /\*\*([^*]+?)\*\*/g;

/** `**x**` becomes Unicode bold. Unbalanced leftover `**` markers are dropped. */
export function markdownBoldToUnicode(text: string): string {
  return text.replace(MD_BOLD_RE, (_m, inner: string) => toUnicodeBold(inner)).replace(/\*\*/g, '');
}

/** Removes `**` markers, keeping the text inside. */
export function stripMarkdownBold(text: string): string {
  return text.replace(MD_BOLD_RE, '$1').replace(/\*\*/g, '');
}

/** U+2800 BRAILLE PATTERN BLANK: looks empty, survives editors that collapse blank lines. */
export const BLANK_LINE_CHAR = '⠀';

/** Plain text: markdown markers removed, Unicode bold mapped back to ASCII, spacer characters dropped. */
export function toPlain(text: string): string {
  return fromUnicodeBold(stripMarkdownBold(text)).replaceAll(BLANK_LINE_CHAR, '');
}

export interface BoldView {
  plain: string;
  /** One flag per UTF-16 unit of `plain`: true when that character was bold (markdown span or Unicode bold). */
  bold: boolean[];
}

/**
 * Plain text plus bold flags, accepting markdown spans, Unicode bold, or a mix.
 * Indices into `plain` and `bold` line up one to one.
 */
export function boldFlags(text: string): BoldView {
  const chars = Array.from(text);
  let plain = '';
  const bold: boolean[] = [];
  let inSpan = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === '*' && chars[i + 1] === '*') {
      inSpan = !inSpan;
      i++;
      continue;
    }
    if (ch === BLANK_LINE_CHAR) continue; // spacer characters carry no meaning
    const ascii = asciiOfBold(ch);
    const out = ascii ?? ch;
    plain += out;
    for (let k = 0; k < out.length; k++) bold.push(ascii !== undefined || inSpan);
  }
  return { plain, bold };
}

/** True when every letter and digit in plain[start, end) is bold, and there is at least one. */
export function isRangeBold(view: BoldView, start: number, end: number): boolean {
  let seen = 0;
  for (let i = start; i < end; i++) {
    if (/[A-Za-z0-9]/.test(view.plain[i] ?? '')) {
      seen++;
      if (!view.bold[i]) return false;
    }
  }
  return seen > 0;
}

export interface BoldFormatting {
  boldBrand: boolean;
  boldFigures: boolean;
  selectiveBold?: boolean;
  /** Character for blank lines in the final text, or null/undefined to keep them blank. */
  blankLineChar?: string | null;
}

/** Markdown bold becomes Unicode bold where the platform uses bold, else the markers are removed. */
export function limitSelectiveBold(text: string, requiredBrand?: string): string {
  let kept = false;
  const normalized = text.replace(/[\u{1D400}-\u{1D433}\u{1D7CE}-\u{1D7D7}]+(?:[ \t.,%/-]*[\u{1D400}-\u{1D433}\u{1D7CE}-\u{1D7D7}]+)*/gu, (run) => `**${fromUnicodeBold(run)}**`);
  const brandSplit = requiredBrand ? new RegExp(`(${requiredBrand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi') : undefined;
  const select = (inner: string): string => {
    if (!inner.trim() || kept || inner.length > 60 || /https?:\/\/|\n/.test(inner)) return inner;
    kept = true;
    return inner.replace(/^(\s*)(.*?)(\s*)$/s, '$1**$2**$3');
  };
  return normalized.replace(MD_BOLD_RE, (_whole, inner: string) => {
    // Required brand mentions never consume the optional emphasis allowance,
    // even when adjacent Unicode bold runs were merged during normalization.
    return brandSplit ? inner.split(brandSplit).map((part, i) => i % 2 ? `**${part}**` : select(part)).join('') : select(inner);
  });
}

export function applyBold(text: string, formatting: Pick<BoldFormatting, 'boldBrand' | 'boldFigures' | 'selectiveBold'>, brandName = 'Ken Research'): string {
  if (formatting.selectiveBold) return markdownBoldToUnicode(limitSelectiveBold(text, formatting.boldBrand ? brandName : undefined));
  return formatting.boldBrand || formatting.boldFigures ? markdownBoldToUnicode(text) : fromUnicodeBold(stripMarkdownBold(text));
}

/** Puts the spacer character on every blank line. Idempotent: a spacer line is not blank. */
export function applySpacers(text: string, formatting: Pick<BoldFormatting, 'blankLineChar'>): string {
  const ch = formatting.blankLineChar;
  if (!ch) return text;
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? ch : line))
    .join('\n');
}

/** The final text for a platform: bold applied, then spacer characters on blank lines. */
export function formatForPlatform(text: string, formatting: BoldFormatting, brandName = 'Ken Research'): string {
  return applySpacers(applyBold(text, formatting, brandName), formatting);
}
