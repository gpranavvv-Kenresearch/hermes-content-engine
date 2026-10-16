import { describe, expect, it } from 'vitest';
import {
  ChartInputError,
  buildBarSpec,
  buildLineSpec,
  chartPoints,
  fontAvailable,
  renderBarChart,
  renderLineChart,
  renderStatCard,
  specToSvg,
} from '../../src/assets/index.js';
import { FAKE_COMPETITOR_URL, geoFacts, makeFact, trendFacts } from '../fixtures/assets/facts.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('assets: chart specs and input rules (no font needed)', () => {
  it('builds a vega-lite bar spec from verified facts', () => {
    const spec = buildBarSpec(geoFacts(), { title: 'Fake comparison' }) as { mark: { type: string }; data: { values: Array<{ label: string; factId: string }> } };
    expect(spec.mark.type).toBe('bar');
    expect(spec.data.values.map((v) => v.label)).toEqual(['Zorbland', 'Quuxia', 'Blorptopia']);
    expect(spec.data.values.map((v) => v.factId)).toEqual(['G1', 'G2', 'G3']);
  });

  it('builds a line spec sorted by period', () => {
    const shuffled = [...trendFacts()].reverse();
    const spec = buildLineSpec(shuffled, { title: 'Fake trend' }) as { mark: { type: string }; data: { values: Array<{ label: string }> } };
    expect(spec.mark.type).toBe('line');
    expect(spec.data.values.map((v) => v.label)).toEqual(['2023', '2024', '2025']);
  });

  it('rejects empty data, unverified facts, bad sources, mixed units, duplicates, too few line points', () => {
    expect(() => buildBarSpec([], { title: 't' })).toThrow(ChartInputError);
    expect(() => buildBarSpec([makeFact({ verificationStatus: 'unverified' })], { title: 't' })).toThrow(ChartInputError);
    expect(() => buildBarSpec([makeFact({ sourceUrl: FAKE_COMPETITOR_URL })], { title: 't' })).toThrow(ChartInputError);
    expect(() => buildBarSpec([makeFact({ id: 'A' }), makeFact({ id: 'B', geography: 'Quuxia', unit: 'percent' })], { title: 't' })).toThrow(/mix units/);
    expect(() => buildBarSpec([makeFact({ id: 'A' }), makeFact({ id: 'B' })], { title: 't' })).toThrow(/duplicate/);
    expect(() => buildLineSpec([makeFact()], { title: 't' })).toThrow(/at least 2/);
    expect(() => chartPoints('bar', [makeFact({ geography: undefined })], { title: 't' })).toThrow(/missing geography/);
  });

  it('renders a spec to SVG headlessly', async () => {
    const svg = await specToSvg(buildBarSpec(geoFacts(), { title: 'Fake comparison' }));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Zorbland');
  });
});

describe.skipIf(!fontAvailable)('assets: chart rendering (needs a font)', () => {
  it('rasterizes bar and line charts to PNG', async () => {
    const bar = await renderBarChart(geoFacts(), { title: 'Fake comparison' });
    const line = await renderLineChart(trendFacts(), { title: 'Fake trend' });
    expect(bar.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(line.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(bar.factIds).toEqual(['G1', 'G2', 'G3']);
  });

  it('is deterministic', async () => {
    const a = await renderLineChart(trendFacts(), { title: 'Fake trend' });
    const b = await renderLineChart(trendFacts(), { title: 'Fake trend' });
    expect(a.png.equals(b.png)).toBe(true);
  });

  it('produces no image on bad data', async () => {
    await expect(renderBarChart([], { title: 't' })).rejects.toBeInstanceOf(ChartInputError);
  });

  it('embeds a chart in a card', async () => {
    const facts = trendFacts();
    const chart = await renderLineChart(facts, { title: 'Fake trend' });
    const plain = await renderStatCard({ facts, title: 'Fake trend card', sourceLabel: 'Ken Research' });
    const withChart = await renderStatCard({ facts, title: 'Fake trend card', sourceLabel: 'Ken Research', chart });
    expect(withChart.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(withChart.record.fileName).not.toBe(plain.record.fileName);
  });
});
