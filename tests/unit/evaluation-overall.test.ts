import { describe, expect, it } from 'vitest';
import {
  SCORE_WEIGHTS,
  combineDimensions,
  scoreContent,
  type DimensionName,
  type ObservedMetrics,
} from '../../src/evaluation/index.js';
import { baseInput, readFixture } from '../fixtures/evaluation/inputs.js';

const observedA: ObservedMetrics = {
  citationVisibility: [{ kind: 'citationVisibility', observedAt: '2026-03-01T00:00:00Z', source: 'manual-check', query: 'fake widget market', engine: 'fake-engine', cited: true, citedUrl: 'https://www.kenresearch.com/fake', citationPosition: 1 }],
  searchPerformance: [{ kind: 'searchPerformance', observedAt: '2026-03-01T00:00:00Z', source: 'fake-export', query: 'fake widget market', dateRange: { start: '2026-02-01', end: '2026-02-28' }, clicks: 900, impressions: 10000, ctr: 0.09, position: 1.2 }],
};
const observedB: ObservedMetrics = {
  citationVisibility: [{ kind: 'citationVisibility', observedAt: '2026-04-01T00:00:00Z', source: 'manual-check', query: 'fake widget market', engine: 'fake-engine', cited: false }],
  searchPerformance: [],
};

describe('evaluation: overall', () => {
  it('weights are documented and sum to 1', () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(Object.keys(SCORE_WEIGHTS).sort()).toEqual(
      ['evidenceCoverage', 'intentMatch', 'originality', 'readability', 'sourceTraceability', 'structure', 'technical'].sort(),
    );
  });

  it('returns all seven dimensions with formula and evidence, scores in 0..1', () => {
    const r = scoreContent(baseInput({ html: readFixture('page.html') }));
    expect(r.dimensions).toHaveLength(7);
    for (const d of r.dimensions) {
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(1);
      expect(d.formula.length).toBeGreaterThan(20);
      expect(Array.isArray(d.evidence)).toBe(true);
      expect(d.weight).toBe(SCORE_WEIGHTS[d.name]);
    }
    expect(r.overall).toBeGreaterThan(0);
    expect(r.overall).toBeLessThanOrEqual(1);
  });

  it('overall is the weighted mean of applicable dimensions (weights renormalised)', () => {
    const r = scoreContent(baseInput());
    const applicable = r.dimensions.filter((d) => d.applicable);
    const manual = applicable.reduce((s, d) => s + SCORE_WEIGHTS[d.name as DimensionName] * d.score, 0) / applicable.reduce((s, d) => s + SCORE_WEIGHTS[d.name as DimensionName], 0);
    expect(r.overall).toBeCloseTo(manual, 3);
    expect(combineDimensions(r.dimensions)).toBe(r.overall);
    expect(r.dimensions.find((d) => d.name === 'technical')!.applicable).toBe(false);
  });

  it('label literally says READINESS and not ranking or citation prediction', () => {
    const r = scoreContent(baseInput());
    expect(r.label).toContain('READINESS');
    expect(r.label).toContain('NOT a ranking or citation prediction');
    expect(r.label).toContain(`${Math.round(r.overall * 100)}/100`);
  });

  it('is reproducible: same input gives deeply equal output', () => {
    const a = scoreContent(baseInput({ html: readFixture('page.html') }));
    const b = scoreContent(baseInput({ html: readFixture('page.html') }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('overall and every dimension are unchanged when only observed metrics change', () => {
    const none = scoreContent(baseInput());
    const a = scoreContent(baseInput({ observed: observedA }));
    const b = scoreContent(baseInput({ observed: observedB }));
    expect(a.overall).toBe(none.overall);
    expect(b.overall).toBe(none.overall);
    expect(a.dimensions).toEqual(none.dimensions);
    expect(b.dimensions).toEqual(none.dimensions);
    expect(a.label).toBe(b.label);
    // Observations are echoed for reporting only.
    expect(a.observed).toEqual(observedA);
    expect(none.observed).toBeUndefined();
  });

  it('responds to content changes (a worse text scores lower)', () => {
    const good = scoreContent(baseInput());
    const worse = scoreContent(baseInput({ claimMappings: [], text: 'Revenue grew 8.2% to 12.5 USD billion.', corpus: ['Revenue grew 8.2% to 12.5 USD billion.'] }));
    expect(worse.overall).toBeLessThan(good.overall);
  });

  it('never reports a score for dimensions it could not measure as if they were measured', () => {
    const r = scoreContent(baseInput({ corpus: [], claimMappings: [], text: 'Words only without figures here, in a short plain sentence about nothing in particular at all.', platform: 'x' }));
    const na = r.dimensions.filter((d) => !d.applicable).map((d) => d.name);
    expect(na).toEqual(expect.arrayContaining(['originality', 'structure', 'technical', 'evidenceCoverage', 'sourceTraceability']));
  });
});
