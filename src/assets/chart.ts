import * as vega from 'vega';
import * as vegaLite from 'vega-lite';
import { Resvg } from '@resvg/resvg-js';
import { FactSchema, type Fact } from '../schemas/index.js';
import { AssetRenderError, ChartInputError } from './errors.js';
import { resolveFont } from './fonts.js';
import { formatNumber, metricLabel, unitLabel } from './format.js';
import { factRenderProblems } from './source-check.js';

export type ChartKind = 'bar' | 'line';
export type ChartCategoryField = 'period' | 'geography' | 'metric';

export interface ChartOptions {
  title: string;
  /** Which fact field labels the x axis. Default: period for line, geography for bar. */
  categoryField?: ChartCategoryField;
  width?: number;
  height?: number;
}

export interface ChartPoint {
  label: string;
  value: number;
  factId: string;
}

export interface ChartImage {
  svg: string;
  png: Buffer;
  width: number;
  height: number;
  factIds: string[];
}

const MIN_POINTS = { bar: 1, line: 2 } as const;
const MAX_POINTS = 24;
const INK = '#1f2937';
const ACCENT = '#0b5cab';

/**
 * Validates facts for charting and turns them into ordered points. Only
 * verified facts from allowed sources, one unit, one label per point.
 */
export function chartPoints(kind: ChartKind, facts: readonly Fact[], options: ChartOptions): { points: ChartPoint[]; unit: string } {
  const issues: string[] = [];
  if (facts.length === 0) throw new ChartInputError(['no facts supplied']);
  const field: ChartCategoryField = options.categoryField ?? (kind === 'line' ? 'period' : 'geography');
  const points: ChartPoint[] = [];
  const seen = new Set<string>();
  const units = new Set<string>();

  for (const raw of facts) {
    const parsed = FactSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push(`fact ${(raw as { id?: string }).id ?? '?'}: not a valid Fact (${parsed.error.issues[0]?.message ?? 'schema error'})`);
      continue;
    }
    const fact = parsed.data;
    issues.push(...factRenderProblems(fact));
    const label = field === 'metric' ? metricLabel(fact.metric) : fact[field];
    if (!label || label.trim() === '') {
      issues.push(`fact ${fact.id}: missing ${field}, needed as the x-axis label`);
      continue;
    }
    if (seen.has(label)) issues.push(`fact ${fact.id}: duplicate x label "${label}"`);
    seen.add(label);
    units.add(unitLabel(fact));
    points.push({ label, value: fact.value, factId: fact.id });
  }

  if (units.size > 1) issues.push(`facts mix units (${[...units].join(', ')}); a chart needs one unit`);
  if (points.length < MIN_POINTS[kind]) issues.push(`a ${kind} chart needs at least ${MIN_POINTS[kind]} point(s), got ${points.length}`);
  if (points.length > MAX_POINTS) issues.push(`too many points (${points.length} > ${MAX_POINTS})`);
  if (issues.length > 0) throw new ChartInputError(issues);

  if (kind === 'line') points.sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
  return { points, unit: [...units][0]! };
}

function buildSpec(kind: ChartKind, points: ChartPoint[], unit: string, options: ChartOptions, family: string): Record<string, unknown> {
  const width = options.width ?? 640;
  const height = options.height ?? 360;
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width,
    height,
    background: '#ffffff',
    padding: 12,
    title: { text: options.title, font: family, fontSize: 18, color: INK, anchor: 'start' },
    data: { values: points },
    mark:
      kind === 'bar'
        ? { type: 'bar', color: ACCENT }
        : { type: 'line', color: ACCENT, strokeWidth: 3, point: { filled: true, size: 70, color: ACCENT } },
    encoding: {
      x: {
        field: 'label',
        type: kind === 'bar' ? 'nominal' : 'ordinal',
        sort: null,
        axis: { title: null, labelFont: family, labelColor: INK, labelAngle: 0 },
      },
      y: {
        field: 'value',
        type: 'quantitative',
        scale: { zero: kind === 'bar' },
        axis: { title: unit, titleFont: family, labelFont: family, labelColor: INK, titleColor: INK },
      },
    },
    config: { font: family, view: { stroke: null }, axis: { gridColor: '#e5e7eb' } },
  };
}

/** Vega-Lite spec for a bar chart of verified facts (exposed so callers/tests can inspect it). */
export function buildBarSpec(facts: readonly Fact[], options: ChartOptions, family = 'sans-serif'): Record<string, unknown> {
  const { points, unit } = chartPoints('bar', facts, options);
  return buildSpec('bar', points, unit, options, family);
}

/** Vega-Lite spec for a line chart of verified facts. */
export function buildLineSpec(facts: readonly Fact[], options: ChartOptions, family = 'sans-serif'): Record<string, unknown> {
  const { points, unit } = chartPoints('line', facts, options);
  return buildSpec('line', points, unit, options, family);
}

/** Compiles the spec and renders it headlessly to an SVG string. */
export async function specToSvg(spec: Record<string, unknown>): Promise<string> {
  try {
    const compiled = vegaLite.compile(spec as unknown as vegaLite.TopLevelSpec).spec;
    const view = new vega.View(vega.parse(compiled as vega.Spec), { renderer: 'none' });
    const svg = await view.toSVG();
    view.finalize();
    return svg;
  } catch (e) {
    throw new AssetRenderError(`Vega rendering failed: ${(e as Error).message}`, e);
  }
}

async function renderChart(kind: ChartKind, facts: readonly Fact[], options: ChartOptions): Promise<ChartImage> {
  const { points, unit } = chartPoints(kind, facts, options); // validate before touching fonts
  const font = resolveFont();
  const svg = await specToSvg(buildSpec(kind, points, unit, options, font.family));
  try {
    const resvg = new Resvg(svg, {
      font: { fontFiles: [font.path], loadSystemFonts: false, defaultFontFamily: font.family },
      background: '#ffffff',
    });
    const rendered = resvg.render();
    return {
      svg,
      png: Buffer.from(rendered.asPng()),
      width: rendered.width,
      height: rendered.height,
      factIds: points.map((p) => p.factId),
    };
  } catch (e) {
    throw new AssetRenderError(`resvg failed to rasterize chart: ${(e as Error).message}`, e);
  }
}

export function renderBarChart(facts: readonly Fact[], options: ChartOptions): Promise<ChartImage> {
  return renderChart('bar', facts, options);
}

export function renderLineChart(facts: readonly Fact[], options: ChartOptions): Promise<ChartImage> {
  return renderChart('line', facts, options);
}

/** Plain-text description of the plotted points, usable as alt text. */
export function describePoints(points: readonly ChartPoint[]): string {
  return points.map((p) => `${p.label}: ${formatNumber(p.value)}`).join('; ');
}
