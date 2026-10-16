import { describe, expect, it } from 'vitest';
import {
  applyFixers,
  normalizeUtmFixer,
  normalizeWhitespaceFixer,
  replaceDashesFixer,
  DEFAULT_FIXERS,
} from '../../src/validation/fixers.js';
import { BASE_URL, config, utmLink, validate, hardCodes } from '../fixtures/validation/helpers.js';

const ctx = { platform: 'x' as const, config };

describe('replaceDashesFixer', () => {
  it('replaces em and en dashes, leaving URLs alone', () => {
    const input = `Growth — fast, 2025–2030. ${BASE_URL}?a=1–2`;
    const out = replaceDashesFixer.fix(input, ctx);
    expect(out).toBe(`Growth - fast, 2025-2030. ${BASE_URL}?a=1–2`);
  });
  it('is idempotent and a no-op on clean text', () => {
    const once = replaceDashesFixer.fix('a—b – c', ctx);
    expect(replaceDashesFixer.fix(once, ctx)).toBe(once);
    expect(replaceDashesFixer.fix('plain-hyphen text', ctx)).toBe('plain-hyphen text');
  });
});

describe('normalizeWhitespaceFixer', () => {
  it('trims, collapses inner spaces and blank-line runs, converts CRLF and nbsp', () => {
    const out = normalizeWhitespaceFixer.fix('  a   b c  \r\n\r\n\r\n\r\nd\t\te  \n', ctx);
    expect(out).toBe('a b c\n\nd e');
  });
  it('keeps leading indentation of list items', () => {
    expect(normalizeWhitespaceFixer.fix('- a\n  - nested', ctx)).toBe('- a\n  - nested');
  });
  it('is idempotent', () => {
    const once = normalizeWhitespaceFixer.fix('x  y\n\n\n\nz   ', ctx);
    expect(normalizeWhitespaceFixer.fix(once, ctx)).toBe(once);
  });
});

describe('normalizeUtmFixer', () => {
  it('adds missing UTM, dedupes and corrects wrong UTM on Ken links only', () => {
    const input = `a ${BASE_URL} b ${BASE_URL}?utm_source=x&utm_source=x c ${BASE_URL}?utm_source=twitter&utm_medium=m&utm_campaign=c d https://www.example.org/p`;
    const out = normalizeUtmFixer.fix(input, ctx);
    expect(out).toBe(`a ${utmLink('x')} b ${utmLink('x')} c ${utmLink('x')} d https://www.example.org/p`);
  });
  it('is idempotent', () => {
    const once = normalizeUtmFixer.fix(`see ${BASE_URL}.`, ctx);
    expect(normalizeUtmFixer.fix(once, ctx)).toBe(once);
    expect(once.endsWith('.')).toBe(true);
  });
  it('uses the UTM of the draft platform', () => {
    expect(normalizeUtmFixer.fix(BASE_URL, { platform: 'linkedin', config })).toBe(utmLink('linkedin'));
  });
});

describe('applyFixers', () => {
  it('records which fixers changed the text and clears the matching hard fails', () => {
    const input = `Ken Research finds growth — fast.   ${BASE_URL} #Widgets`;
    expect(hardCodes(validate(input))).toEqual(expect.arrayContaining(['BANNED_CHARACTER', 'MISSING_UTM']));
    const result = applyFixers(input, ctx);
    expect(result.applied.map((a) => a.id)).toEqual(['REPLACE_DASHES', 'NORMALIZE_UTM', 'NORMALIZE_WHITESPACE']);
    expect(hardCodes(validate(result.text))).toEqual([]);
  });
  it('is idempotent as a pipeline and reports nothing on clean text', () => {
    const first = applyFixers(`a — b ${BASE_URL}`, ctx);
    const second = applyFixers(first.text, ctx);
    expect(second.text).toBe(first.text);
    expect(second.applied).toEqual([]);
  });
  it('exposes the default fixer list in a stable order', () => {
    expect(DEFAULT_FIXERS.map((f) => f.id)).toEqual(['REPLACE_DASHES', 'STRIP_EMOJI', 'NORMALIZE_UTM', 'STRIP_BOLD', 'STRIP_EXTRA_BOLD', 'ENSURE_BOLD', 'ENSURE_BRAND_HASHTAG', 'NORMALIZE_WHITESPACE']);
  });
});
