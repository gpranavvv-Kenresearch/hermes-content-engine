import { createHash } from 'node:crypto';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { FactSchema, type Fact } from '../schemas/index.js';
import { urlHost } from '../utils/utm.js';
import type { ChartImage } from './chart.js';
import { AssetRenderError, CardInputError } from './errors.js';
import { resolveFont } from './fonts.js';
import { formatFactValue, metricLabel } from './format.js';
import { factRenderProblems } from './source-check.js';

/** Bump when layout/typography changes so stored assets can be told apart. */
export const RENDER_VERSION = 'stat-card-1';

export interface AssetRecord {
  /** `<sha256 of the PNG bytes>.png` */
  fileName: string;
  factIds: string[];
  renderVersion: string;
  width: number;
  height: number;
  createdAt: string;
}

export type CardTheme = 'light' | 'dark';

export interface CardSize {
  width: number;
  height: number;
}

export const CARD_SIZES = {
  landscape: { width: 1200, height: 630 },
  square: { width: 1080, height: 1080 },
} as const satisfies Record<string, CardSize>;

export interface RenderStatCardInput {
  facts: readonly Fact[];
  title: string;
  /** Human readable source, e.g. "Ken Research". The source host is also printed. */
  sourceLabel: string;
  size?: CardSize;
  theme?: CardTheme;
  /** Optional chart (from chart.ts) embedded as a PNG data URI. Its facts must be among `facts`. */
  chart?: ChartImage;
  /** Only affects the record, never the image bytes. */
  now?: Date;
}

export const MAX_CARD_FACTS = 6;

const THEMES = {
  light: { bg: '#ffffff', ink: '#111827', muted: '#4b5563', accent: '#0b5cab', panel: '#f3f4f6' },
  dark: { bg: '#0f172a', ink: '#f8fafc', muted: '#cbd5e1', accent: '#7dd3fc', panel: '#1e293b' },
} as const;

type El = { type: string; props: Record<string, unknown> };

function el(type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): El {
  return { type, props: { ...extra, style, ...(children === undefined ? {} : { children }) } };
}

/** Checks everything the card promises to show. Returns all problems at once. */
export function validateCardInput(input: RenderStatCardInput): { facts: Fact[]; issues: string[] } {
  const issues: string[] = [];
  const facts: Fact[] = [];
  if (!input.title || input.title.trim() === '') issues.push('title is empty');
  if (!input.sourceLabel || input.sourceLabel.trim() === '') issues.push('sourceLabel is empty');
  if (input.facts.length === 0) issues.push('no facts supplied');
  if (input.facts.length > MAX_CARD_FACTS) issues.push(`too many facts (${input.facts.length} > ${MAX_CARD_FACTS})`);
  const size = input.size ?? CARD_SIZES.landscape;
  if (!(Number.isInteger(size.width) && Number.isInteger(size.height) && size.width >= 200 && size.height >= 200 && size.width <= 4000 && size.height <= 4000)) {
    issues.push(`size ${size.width}x${size.height} is out of range (200..4000, integers)`);
  }

  for (const raw of input.facts) {
    const parsed = FactSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push(`fact ${(raw as { id?: string }).id ?? '?'}: not a valid Fact (${parsed.error.issues[0]?.message ?? 'schema error'})`);
      continue;
    }
    const fact = parsed.data;
    issues.push(...factRenderProblems(fact));
    if (!fact.period || fact.period.trim() === '') issues.push(`fact ${fact.id}: period is missing, it must be visible on the card`);
    if (!fact.geography || fact.geography.trim() === '') issues.push(`fact ${fact.id}: geography is missing, it must be visible on the card`);
    facts.push(fact);
  }

  if (input.chart) {
    const ids = new Set(facts.map((f) => f.id));
    for (const id of input.chart.factIds) {
      if (!ids.has(id)) issues.push(`chart uses fact ${id} that is not among the card facts`);
    }
  }
  return { facts, issues };
}

function buildTree(input: RenderStatCardInput, facts: Fact[], size: CardSize): El {
  const t = THEMES[input.theme ?? 'light'];
  const compact = facts.length > 3 || size.height < 500;
  const base = Math.min(size.width, size.height);
  const valueSize = Math.round(base * (facts.length === 1 ? 0.12 : compact ? 0.055 : 0.075));
  const labelSize = Math.max(16, Math.round(valueSize * 0.34));
  const titleSize = Math.max(22, Math.round(base * 0.05));
  const pad = Math.round(base * 0.06);

  const rows = facts.map((f) =>
    el(
      'div',
      { display: 'flex', flexDirection: 'column', backgroundColor: t.panel, borderRadius: 12, padding: Math.round(pad * 0.35), marginTop: Math.round(pad * 0.25) },
      [
        el('div', { display: 'flex', fontSize: valueSize, color: t.accent }, formatFactValue(f)),
        el('div', { display: 'flex', fontSize: labelSize, color: t.ink }, metricLabel(f.metric)),
        el('div', { display: 'flex', fontSize: Math.round(labelSize * 0.9), color: t.muted }, `${f.geography} | ${f.period}`),
      ],
    ),
  );

  const chartW = input.chart ? Math.round(size.width * 0.38) : 0;
  const innerW = size.width - 2 * pad;
  const listW = input.chart ? innerW - chartW - pad : innerW;
  const body: El[] = [el('div', { display: 'flex', flexDirection: 'column', width: listW }, rows)];
  if (input.chart) {
    const chartH = Math.round((chartW * input.chart.height) / input.chart.width);
    body.push(
      el('div', { display: 'flex', marginLeft: pad, alignItems: 'center' }, [
        el('img', { width: chartW, height: chartH }, undefined, {
          src: `data:image/png;base64,${input.chart.png.toString('base64')}`,
          width: chartW,
          height: chartH,
        }),
      ]),
    );
  }

  const sourceHosts = [...new Set(facts.map((f) => urlHost(f.sourceUrl)).filter((h): h is string => h !== null))].join(', ');

  return el(
    'div',
    { display: 'flex', flexDirection: 'column', width: size.width - 2 * pad, height: size.height - 2 * pad, backgroundColor: t.bg, color: t.ink, padding: pad, justifyContent: 'space-between' },
    [
      el('div', { display: 'flex', fontSize: titleSize, color: t.ink }, input.title),
      el('div', { display: 'flex', flexDirection: 'row', flexGrow: 1, minHeight: 0, marginTop: Math.round(pad * 0.3) }, body),
      el('div', { display: 'flex', fontSize: Math.max(14, Math.round(labelSize * 0.8)), color: t.muted, marginTop: Math.round(pad * 0.3) }, `Source: ${input.sourceLabel} (${sourceHosts})`),
    ],
  );
}

/** Validates and lays out the card as SVG (Satori). Exposed for inspection and tests. */
export async function renderStatCardSvg(input: RenderStatCardInput): Promise<{ svg: string; facts: Fact[]; size: CardSize }> {
  const { facts, issues } = validateCardInput(input);
  if (issues.length > 0) throw new CardInputError(issues);
  const size = input.size ?? CARD_SIZES.landscape;
  const font = resolveFont();
  try {
    const svg = await satori(buildTree(input, facts, size) as unknown as Parameters<typeof satori>[0], {
      width: size.width,
      height: size.height,
      fonts: [{ name: font.family, data: font.data, weight: 400, style: 'normal' }],
    });
    return { svg, facts, size };
  } catch (e) {
    throw new AssetRenderError(`Satori layout failed: ${(e as Error).message}`, e);
  }
}

/**
 * Renders a stat card PNG. Deterministic: identical input gives identical
 * bytes. Throws CardInputError (and produces nothing) when any fact is not
 * verified, comes from a disallowed source, or lacks value/unit/period/geography.
 */
export async function renderStatCard(input: RenderStatCardInput): Promise<{ png: Buffer; record: AssetRecord }> {
  const { svg, facts } = await renderStatCardSvg(input);

  let png: Buffer;
  let width: number;
  let height: number;
  try {
    const rendered = new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } }).render();
    png = Buffer.from(rendered.asPng());
    width = rendered.width;
    height = rendered.height;
  } catch (e) {
    throw new AssetRenderError(`resvg failed to rasterize card: ${(e as Error).message}`, e);
  }

  const record: AssetRecord = {
    fileName: `${createHash('sha256').update(png).digest('hex')}.png`,
    factIds: facts.map((f) => f.id),
    renderVersion: RENDER_VERSION,
    width,
    height,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  return { png, record };
}
