import type { ValidationIssue } from '../../schemas/index.js';

function normalize(text: string): string {
  return text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Quote-led posts must reproduce an excerpt of a supplied primary-source note. */
export function checkOpeningQuote(plain: string, notes: readonly string[]): ValidationIssue[] {
  const opening = plain.trimStart().match(/^[“"]([^”"\n]+)[”"]/u)?.[1];
  const quote = opening ? normalize(opening).replace(/[.,;:!?]+$/, '') : '';
  const words = quote.split(/\s+/).filter(Boolean).length;
  const supported = words >= 6 && notes.some((note) => {
    const source = normalize(note);
    const start = source.indexOf(quote);
    // Match a complete excerpt, never a fragment inside another word.
    return start >= 0 && (start === 0 || !/[\p{L}\p{N}]/u.test(source[start - 1]!))
      && (start + quote.length === source.length || !/[\p{L}\p{N}]/u.test(source[start + quote.length]!));
  });
  return supported ? [] : [{
    code: 'UNSUPPORTED_SOURCE_QUOTE', severity: 'hard_fail',
    message: 'Open with an exact excerpt of at least six words from a supplied Ken Research source note, in quotation marks. Preserve the wording; attribute it in the next paragraph.',
  }];
}
