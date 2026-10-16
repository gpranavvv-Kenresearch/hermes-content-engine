import { describe, expect, it } from 'vitest';
import {
  calibrateThreshold,
  checkDuplicates,
  DEFAULT_DEDUP_THRESHOLDS,
  normalizedHash,
  UNCALIBRATED_EXACT_DUPLICATE_THRESHOLD,
  UNCALIBRATED_NEAR_DUPLICATE_THRESHOLD,
} from '../../src/validation/dedup.js';

const A = 'Ken Research finds Examplestan widget buyers weigh service coverage above price when signing multi-year supply contracts.';

describe('dedup thresholds', () => {
  it('are separate, exported, and labelled uncalibrated', () => {
    expect(UNCALIBRATED_EXACT_DUPLICATE_THRESHOLD).toBe(0.98);
    expect(UNCALIBRATED_NEAR_DUPLICATE_THRESHOLD).toBe(0.7);
    expect(DEFAULT_DEDUP_THRESHOLDS).toEqual({ exact: 0.98, near: 0.7 });
  });
});

describe('normalizedHash', () => {
  it('ignores case, punctuation, spacing and URLs', () => {
    expect(normalizedHash(A + ' https://www.kenresearch.com/a?utm_source=x')).toBe(
      normalizedHash(A.toUpperCase().replace('.', '!') + '   https://www.kenresearch.com/b'),
    );
  });
  it('differs for different text', () => {
    expect(normalizedHash(A)).not.toBe(normalizedHash(A + ' Extra sentence.'));
  });
});

describe('checkDuplicates', () => {
  it('flags an exact duplicate as hard_fail', () => {
    const issues = checkDuplicates(A, ['something else entirely', A.toLowerCase() + '!!']);
    expect(issues.map((i) => [i.code, i.severity])).toEqual([['EXACT_DUPLICATE', 'hard_fail']]);
  });
  it('flags a near duplicate as review only', () => {
    const near = A.replace('above', 'over');
    const issues = checkDuplicates(near, [A], { exact: 0.98, near: 0.5 });
    expect(issues.map((i) => [i.code, i.severity])).toEqual([['NEAR_DUPLICATE', 'review']]);
  });
  it('does not flag clearly different posts on the same topic', () => {
    const other = 'Regulation is tightening around certification in Examplestan, which raises entry costs for small importers and favours firms with local content.';
    expect(checkDuplicates(other, [A])).toEqual([]);
  });
  it('returns nothing without history', () => {
    expect(checkDuplicates(A, [])).toEqual([]);
  });
});

describe('calibrateThreshold', () => {
  const pairs = [
    { a: A, b: A, duplicate: true },
    { a: A, b: A.replace('weigh', 'rank'), duplicate: true },
    { a: A, b: 'Completely different sentence about logistics hubs and coastal provinces in the region.', duplicate: false },
    { a: A, b: 'Ken Research finds Examplestan widget buyers weigh something else entirely at renewal time.', duplicate: false },
  ];
  it('reports precision and recall per candidate threshold', () => {
    const stats = calibrateThreshold(pairs, [0.1, 0.5, 0.99]);
    expect(stats.map((s) => s.threshold)).toEqual([0.1, 0.5, 0.99]);
    const strict = stats.find((s) => s.threshold === 0.99)!;
    expect(strict.truePositives).toBe(1);
    expect(strict.falsePositives).toBe(0);
    expect(strict.precision).toBe(1);
    expect(strict.recall).toBe(0.5);
    const loose = stats.find((s) => s.threshold === 0.1)!;
    expect(loose.recall).toBe(1);
    expect(loose.precision!).toBeLessThan(1);
  });
  it('returns null precision when nothing is predicted positive, null recall when no positives', () => {
    expect(calibrateThreshold(pairs, [1.01])[0]!.precision).toBeNull();
    expect(calibrateThreshold([{ a: A, b: 'zzz', duplicate: false }], [0.5])[0]!.recall).toBeNull();
  });
});
