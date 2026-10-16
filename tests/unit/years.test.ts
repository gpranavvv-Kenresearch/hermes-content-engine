import { describe, expect, it } from 'vitest';
import { selectBriefFacts } from '../../src/strategy/index.js';
import { MIN_DATA_YEAR, isStaleFact, yearsInText, yearsOf } from '../../src/utils/years.js';
import { checkYears } from '../../src/validation/checks/years.js';
import { sampleFact } from '../fixtures/validation/helpers.js';

const fact = (id: string, period: string | undefined, value = 1) => ({ ...sampleFact, id, value, period, verificationStatus: 'verified' as const });
const codes = (text: string, facts = [fact('F1', '2025-2031')], notes: string[] = []) => checkYears(text, facts, notes).map((i) => i.code);

describe('years', () => {
  it('knows which facts are stale', () => {
    expect(MIN_DATA_YEAR).toBe(2024);
    expect(yearsOf('2025-2031')).toEqual([2025, 2031]);
    expect(isStaleFact({ period: '2020-2025' })).toBe(true);
    expect(isStaleFact({ period: '2023' })).toBe(true);
    expect(isStaleFact({ period: '2024' })).toBe(false);
    expect(isStaleFact({ period: '2025-2031' })).toBe(false);
    expect(isStaleFact({ period: undefined })).toBe(false); // no period: no year is ever written
  });

  it('drops stale facts when choosing what a post may use', () => {
    const picked = selectBriefFacts([fact('old', '2020-2025'), fact('new', '2025-2031', 2), fact('none', undefined, 3)]);
    expect(picked.map((f) => f.id)).toEqual(['new', 'none']);
  });

  it('ignores years inside links', () => {
    expect(yearsInText('Growth by 2031. https://example.com/report-2019?x=2020')).toEqual([2031]);
  });

  it('rejects any year before 2024', () => {
    expect(codes('The market rose from 2020 to 2025.')).toContain('STALE_YEAR');
    expect(codes('Since 2019 the market grew.')).toContain('STALE_YEAR');
    expect(codes('Link https://example.com/2019 is fine, reaching 2031.')).toEqual([]);
  });

  it('rejects a year no fact carries, and writes no year for a fact without a period', () => {
    expect(codes('Demand rises through 2030.')).toEqual(['UNSUPPORTED_YEAR']);
    expect(codes('Demand rises through 2031.')).toEqual([]);
    expect(codes('Demand rises in 2025.', [fact('F1', undefined)])).toEqual(['UNSUPPORTED_YEAR']);
    expect(codes('Demand rises with no year at all.', [fact('F1', undefined)])).toEqual([]);
  });

  it('accepts a year that a source note carries, and skips the supported-year check without facts', () => {
    expect(codes('Rules apply from 2026.', [fact('F1', '2025')], ['New rules take effect in 2026.'])).toEqual([]);
    expect(codes('Rules apply from 2026.', [])).toEqual([]);
  });
});
