import { describe, expect, it } from 'vitest';
import type { Fact } from '../../src/schemas/index.js';
import { checkNarrativeClaims } from '../../src/validation/narrative-claims.js';
import { sampleFact } from '../fixtures/validation/helpers.js';

const cagr = (value: number): Fact => ({ ...sampleFact, id: `C${value}`, metric: 'cagr', value, unit: 'percent', period: '2025-2031' });
const flagged = (text: string, rate: number) => checkNarrativeClaims(text, [sampleFact, cagr(rate)]).filter((i) => i.code === 'UNSUPPORTED_NARRATIVE_CLAIM');

describe('growth-band labels must fit the CAGR fact', () => {
  it('flags "mid-single-digit" for 7.2% (it is high single-digit), the error seen in live drafts', () => {
    const issues = flagged('The data points to a steady, mid-single-digit expansion.', 7.2);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('mid-single-digit');
    expect(issues[0]!.message).toContain('7.2%');
  });

  it.each([
    ['high single-digit growth', 7.2],
    ['high-single-digit growth', 9.9],
    ['mid single digit growth', 5.5],
    ['low-single-digit growth', 2.1],
    ['single-digit growth', 7.2],
    ['double-digit growth', 10.1],
    ['double digit growth', 16.1],
  ])('accepts "%s" at %s%%', (text, rate) => {
    expect(flagged(`The market shows ${text}.`, rate)).toEqual([]);
  });

  it.each([
    ['double-digit growth', 7.2],
    ['low-single-digit growth', 7.2],
    ['high single-digit growth', 5.5],
    ['single-digit growth', 10.1],
  ])('flags "%s" at %s%%', (text, rate) => {
    expect(flagged(`The market shows ${text}.`, rate)).toHaveLength(1);
  });

  it('flags any such label when no growth rate is supplied', () => {
    const issues = checkNarrativeClaims('Expect double-digit growth.', [sampleFact]);
    expect(issues.map((i) => i.code)).toContain('UNSUPPORTED_NARRATIVE_CLAIM');
    expect(issues[0]!.message).toContain('no growth rate is supplied');
  });

  it('leaves text without such labels alone', () => {
    expect(flagged('The market grows at 7.2% a year.', 7.2)).toEqual([]);
  });
});
