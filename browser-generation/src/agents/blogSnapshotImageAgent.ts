/**
 * blogSnapshotImageAgent.ts — renders the "Key Snapshot Metrics for Image"
 * text block (parsed from the New Logic sheet's "Image Data" column, itself
 * produced by the V1.3 master blog prompt — see blogGenAgent.ts) into the
 * mid-article snapshot PNG that fills the article's
 * <figure><img src="YOUR_IMAGE_URL_HERE">...</figure> placeholder.
 *
 * Ported from the design in
 * "Desktop/agents/generate_table_image.py" (Python + html2image, hardcoded
 * data) — reimplemented here in TS using Playwright (already a project
 * dependency, no new Python/html2image install needed) and driven by
 * whatever metrics the prompt actually returned instead of a fixed template.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { uploadFileToGoogleDrive } from '../utils/googleDriveUpload.js';

export interface SnapshotMetric {
  label: string;
  value: string;
}

// A bare domain ("kenresearch.com") or a lone "+N" — ChatGPT's web-search
// citation pills leaking into the plain-text metrics list as their own
// line. Already stripped in blogGenAgent.ts, filtered again here
// defensively in case imageData ever comes from somewhere else.
const CITATION_CHIP_LINE_RE = /^(?:(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\s*\+\d+)?|\+\d+)$/i;

/**
 * Parse the "Key Snapshot Metrics for Image" block — one metric per line,
 * "Label: Value" — into structured pairs. Tolerates the odd blank line or a
 * leaked "5–7 supported metrics" instruction line (already stripped in
 * blogGenAgent.ts, but stripped again here defensively).
 */
export function parseSnapshotMetrics(imageData: string): SnapshotMetric[] {
  return imageData
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\d[\s\S]{0,4}\d?\s*supported metrics$/i.test(l))
    .filter((l) => !CITATION_CHIP_LINE_RE.test(l))
    .map((line) => {
      const idx = line.indexOf(':');
      if (idx === -1) return { label: line, value: '' };
      return { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
    })
    .filter((m) => m.label && m.value);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface TrendPoint { value: string; year: string; pct: number; }
interface TrendMetric extends SnapshotMetric { points: TrendPoint[]; }

function firstNumber(s: string): number | null {
  const m = s.replace(/,/g, '').match(/[\d]+\.?\d*/);
  return m ? parseFloat(m[0]) : null;
}

function firstYear(s: string): string {
  const m = s.match(/(19|20)\d{2}/);
  return m ? m[0] : '';
}

/** Strip a trailing "in 2025" clause once the year has been pulled out separately, so the bar-row value label doesn't repeat it. */
function stripYearClause(s: string): string {
  return s.replace(/\s*(?:in|by)\s*(19|20)\d{2}\s*$/i, '').trim();
}

/** A metric whose value is "X ... → Y ... [→ Z ...]" (two or more chronological points, arrow-separated) becomes a real multi-bar comparison chart instead of a flat stat tile — any number of points, not just before/after. */
function asTrend(m: SnapshotMetric): TrendMetric | null {
  const parts = m.value.split(/→|->/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const nums = parts.map(firstNumber);
  if (nums.some((n) => n === null)) return null;
  const max = Math.max(...(nums as number[]), 0.0001);
  const points: TrendPoint[] = parts.map((p, i) => ({
    value: stripYearClause(p),
    year: firstYear(p) || (i === 0 ? 'Before' : 'After'),
    // Floor at 15% so the smallest bar stays visible against the largest one.
    pct: Math.max(15, Math.round(((nums[i] as number) / max) * 100)),
  }));
  return { ...m, points };
}

// Original subtle, muted palette (restored — kept deliberately understated
// rather than the more saturated CVD-reference hues). Exported so
// blogLandscapeImageAgent.ts's second image matches this one's look exactly.
export const CHART_COLORS = ['#2f5fa3', '#3f8f6c', '#c1852f', '#7d6aa8', '#b25064', '#3f8b9c'];
// Same-hue sequential pair (a lighter tint and the base navy) for a metric
// that is one series measured at two points in time (base → forecast) — a
// shade change reads as "later", where two different colors would wrongly
// imply two different things being compared.
const SEQ_EARLY = '#8aa6cf';
const SEQ_LATE = '#2f5fa3';
export const STATUS_GOOD = '#3f8f6c';
export const INK_PRIMARY = '#0b1220';
export const INK_SECONDARY = '#5b6b82';
const INK_MUTED = '#8a97ab';

// "USD 1.8 billion in 2025" -> value "USD 1.8 billion", year "2025" — shared by
// the hero tiles and the KPI/structure fallback rows.
export function splitTrailingYear(m: SnapshotMetric): { value: string; year: string } {
  const match = m.value.match(/^(.+?)\s+in\s+((?:19|20)\d{2})$/i);
  return match ? { value: match[1].trim(), year: match[2] } : { value: m.value, year: '' };
}

/** A single-value metric whose label reads like a proportion of a whole ("X Share", "Share of Y") — donut material, not a growth-rate percentage like CAGR. */
function isShareMetric(m: SnapshotMetric): boolean {
  return /share/i.test(m.label) && /%/.test(m.value) && !/breakdown/i.test(m.label);
}

/** A percentage metric that isn't a "share" — CAGR, growth rate, penetration rate, adoption rate, etc. — becomes a solid pie gauge, visually distinct from the ring donut used for shares. */
function isGaugeMetric(m: SnapshotMetric): boolean {
  return /%/.test(m.value) && /cagr|growth rate|growth|penetration|adoption|utilization|conversion/i.test(m.label);
}

export interface NamedShare { name: string; pct: number; }

/** "Name1 X%, Name2 Y%, ..." (or "Name1: X%, ...") → structured pairs, for a Segment Breakdown donut or a Market Share bar chart. */
export function parseNamePercentList(value: string): NamedShare[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(.+?)[\s:]+([\d.]+)\s*%$/);
      if (!m) return null;
      return { name: m[1].trim(), pct: parseFloat(m[2]) };
    })
    .filter((x): x is NamedShare => x !== null);
}

/** Comma-separated plain names ("Name1, Name2, ...") — for a Competitive Landscape / Key Players list. */
function parseNameList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

// ── Chart-type replacements (2026-09-28): no bar/line/pie/donut/column
// charts anywhere in this image — packed bubbles for name+% breakdowns
// (Segment Breakdown, Market Share by Player), a waffle/dot-matrix grid for
// single share-of-whole percentages, and size-scaled bubbles connected by an
// arrow for "before → after" trends. ──────────────────────────────────────

/** Packed bubble chart — circle AREA proportional to pct (radius = k*sqrt(pct)), one color per entry, the top entry gets a "Leading" badge + highlight ring. */
function buildBubbleWidget(title: string, items: NamedShare[]): string {
  const sorted = [...items].sort((a, b) => b.pct - a.pct);
  const maxPct = sorted[0]?.pct || 1;
  const k = 30 / Math.sqrt(maxPct);
  const bubbles = sorted.map((s, i) => {
    const r = Math.max(13, Math.round(k * Math.sqrt(s.pct)));
    const isLeading = i === 0;
    return `
      <div class="bubble-col">
        ${isLeading ? '<div class="leading-badge">Leading</div>' : ''}
        <div class="bubble${isLeading ? ' bubble-leading' : ''}" style="width:${r * 2}px;height:${r * 2}px;background:${CHART_COLORS[i % CHART_COLORS.length]};">
          <span class="bubble-pct">${s.pct}%</span>
        </div>
        <div class="bubble-name">${escapeHtml(s.name)}</div>
      </div>`;
  }).join('');
  return `
      <div class="widget" style="--accent:${CHART_COLORS[0]};">
        <div class="chart-title">${escapeHtml(title)}</div>
        <div class="bubble-row">${bubbles}</div>
      </div>`;
}

/** Waffle / dot-matrix grid (50 dots, filled = pct) — the standard non-donut way to show "X% of a whole." */
function buildWaffleWidget(title: string, pct: number, color: string, caption: string): string {
  const total = 50;
  const filled = Math.round((pct / 100) * total);
  let dots = '';
  for (let i = 0; i < total; i++) {
    dots += `<span class="waffle-dot" style="background:${i < filled ? color : '#e3e8f2'};"></span>`;
  }
  return `
      <div class="widget" style="--accent:${color};">
        <div class="chart-title">${escapeHtml(title)}</div>
        <div class="waffle-wrap">
          <div class="waffle-grid">${dots}</div>
          <div class="waffle-side">
            <div class="waffle-pct" style="color:${color};">${pct}%</div>
            <div class="waffle-label">${escapeHtml(caption)}</div>
          </div>
        </div>
      </div>`;
}

/** "As of {year}" when the metric carries a year, else a generic non-fabricated caption. */
function waffleCaption(m: SnapshotMetric): string {
  const { year } = splitTrailingYear(m);
  return year ? `As of ${year}` : 'Reported figure';
}

/** Size-scaled bubbles connected by arrows — a "before → after" (or multi-point) trend without a bar/line chart. Earliest point is smallest/lightest, latest is largest/full-color. */
// "4.63 million hectare-equivalent packs" -> {main: "4.63", unit: "million"};
// "USD 189.0" -> {main: "USD 189.0", unit: ""} — keeps bubble text short and
// consistent regardless of how much descriptive text follows the number
// (the panel title already gives that context; the bubble only needs the
// number itself).
function compactTrendValue(value: string): { main: string; unit: string } {
  const m = value.match(/^(.*?[\d,]+\.?\d*)\s*(million|billion|thousand|trillion)?/i);
  return m ? { main: m[1].trim(), unit: m[2] || '' } : { main: value, unit: '' };
}

function buildTrendBubbleWidget(title: string, points: TrendPoint[], color: string): string {
  const n = points.length;
  const minPx = 44, maxPx = 82;
  const items = points.map((p, i) => {
    const size = minPx + (p.pct / 100) * (maxPx - minPx);
    const opacity = n === 1 ? 1 : 0.35 + (i / (n - 1)) * 0.65;
    const textColor = opacity > 0.6 ? '#ffffff' : '#1e293b';
    const { main, unit } = compactTrendValue(p.value);
    return `
      <div class="trend-bubble-item">
        <div class="trend-bubble" style="width:${size}px;height:${size}px;background:${color};opacity:${opacity.toFixed(2)};color:${textColor};">
          <div class="trend-bubble-main">${escapeHtml(main)}</div>
          ${unit ? `<div class="trend-bubble-unit">${escapeHtml(unit)}</div>` : ''}
        </div>
        <div class="trend-bubble-year">${escapeHtml(p.year)}</div>
      </div>`;
  });
  const withArrows = items.reduce<string[]>((acc, cur, i) => i === 0 ? [cur] : [...acc, '<span class="trend-arrow">&#8594;</span>', cur], []).join('');
  return `
      <div class="widget" style="--accent:${color};">
        <div class="chart-title">${escapeHtml(title)}</div>
        <div class="trend-bubble-row">${withArrows}</div>
      </div>`;
}

/**
 * Ken Research "Market at a Glance" snapshot card — three columns, matching
 * the reference layout: KPI stat boxes on the left, a Market Structure
 * key/value table (+ a real donut chart for any "Share" metric) in the
 * middle, and a real horizontal comparison bar chart for any "before →
 * after" metric on the right. Every element is driven off whatever the
 * prompt's Key Snapshot Metrics actually contain — nothing is hardcoded, and
 * a column collapses gracefully when its data type isn't present.
 */
/**
 * Find the base-year/forecast-year market-value pair (+ CAGR) inside a parsed
 * metrics list — the same "one series at two points in time" pair the hero
 * row renders here. Exported so blogLandscapeImageAgent.ts's second image can
 * reuse the exact same base/forecast/CAGR figures instead of asking the LLM
 * to repeat them in a second data block.
 */
/**
 * ChatGPT occasionally writes the Base Market Value / Forecast Value line
 * using the trend-chain "→" format that's meant for OTHER metrics instead of
 * a single value — e.g. "Forecast Value: USD 1,700 million in 2025 → USD
 * 3,465 million in 2031" — confirmed live 2026-09-28, producing a garbled,
 * overflowing hero bubble/tile. Strip any such chain down to just the
 * endpoint this metric actually represents: the FIRST segment for a base
 * value, the LAST for a forecast value. A value with no "→" passes through
 * unchanged.
 */
function cleanHeroValue(m: SnapshotMetric, take: 'first' | 'last'): SnapshotMetric {
  const parts = m.value.split(/→|->/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return m;
  const picked = take === 'first' ? parts[0] : parts[parts.length - 1];
  return { ...m, value: picked };
}

export function findHeroMetrics(metrics: SnapshotMetric[]): {
  base?: SnapshotMetric; forecast?: SnapshotMetric; cagr?: SnapshotMetric;
} {
  const base = metrics.find((m) => /(market size|market value|base[\s-]?(year )?(market )?value)/i.test(m.label) && !/forecast/i.test(m.label));
  const forecast = metrics.find((m) => /forecast/i.test(m.label) && /(value|size|market)/i.test(m.label));
  const cagr = metrics.find((m) => /cagr/i.test(m.label) && /%/.test(m.value));
  if (!base || !forecast) return {};
  return { base: cleanHeroValue(base, 'first'), forecast: cleanHeroValue(forecast, 'last'), cagr };
}

export function buildSnapshotHtml(marketName: string, metrics: SnapshotMetric[]): string {
  // Pull out the special multi-value fields first (Segment Breakdown / Key
  // Players / Market Share) — these don't go through the trend/single/share
  // classification below, they drive their own chart sections.
  const segmentMetric = metrics.find((m) => /segment breakdown/i.test(m.label));
  const keyPlayersMetric = metrics.find((m) => /key players|^competitors?$/i.test(m.label));
  const marketShareMetric = metrics.find((m) => /market share/i.test(m.label));

  // Headline pair: the base-year value and the forecast-year value of the
  // SAME market-size series — rendered as a hero row (base → CAGR → forecast)
  // instead of two unrelated stat boxes, since they're one series at two
  // points in time, not two categorical facts.
  const { base: baseValueMetric, forecast: forecastValueMetric, cagr: cagrMetric } = findHeroMetrics(metrics);
  const hasHeroPair = !!(baseValueMetric && forecastValueMetric);
  const heroCagr = hasHeroPair ? cagrMetric : undefined;

  const specialLabels = new Set(
    [segmentMetric, keyPlayersMetric, marketShareMetric, ...(hasHeroPair ? [baseValueMetric, forecastValueMetric, heroCagr] : [])]
      .filter(Boolean)
      .map((m) => m!.label)
  );
  const remaining = metrics.filter((m) => !specialLabels.has(m.label));

  const trends: TrendMetric[] = [];
  const singles: SnapshotMetric[] = [];
  for (const m of remaining) {
    const t = asTrend(m);
    if (t) trends.push(t); else singles.push(m);
  }

  // Up to 2 share-of-whole metrics each get their own donut (e.g. two
  // regional/channel share stats in the same dataset) instead of only the
  // first one being shown and the rest silently dropped.
  const shareMetrics = singles.filter(isShareMetric).slice(0, 2);
  const gaugeMetrics = singles.filter((m) => !isShareMetric(m) && isGaugeMetric(m));
  const plainSingles = singles.filter((m) => !isShareMetric(m) && !isGaugeMetric(m));

  // When there's no recognizable base→forecast pair, fall back to the old
  // behavior: the first couple of plain singles become headline KPI tiles.
  const kpiMetrics = hasHeroPair ? [] : plainSingles.slice(0, 2);
  const structureMetrics = hasHeroPair ? plainSingles : plainSingles.slice(kpiMetrics.length);

  const heroHtml = hasHeroPair ? (() => {
    const base = splitTrailingYear(baseValueMetric!);
    const fcst = splitTrailingYear(forecastValueMetric!);
    return `
    <div class="hero-row">
      <div class="hero-tile">
        <div class="hero-value" style="color:${SEQ_EARLY};">${escapeHtml(base.value)}</div>
        <div class="hero-label">${escapeHtml(baseValueMetric!.label)}${base.year ? ` &middot; ${escapeHtml(base.year)}` : ''}</div>
      </div>
      <div class="hero-connector">
        <div class="hero-arrow">&#8594;</div>
        ${heroCagr ? `<div class="hero-cagr"><span class="hero-cagr-arrow">&#9650;</span>${escapeHtml(heroCagr.value)} CAGR</div>` : ''}
      </div>
      <div class="hero-tile">
        <div class="hero-value" style="color:${SEQ_LATE};">${escapeHtml(fcst.value)}</div>
        <div class="hero-label">${escapeHtml(forecastValueMetric!.label)}${fcst.year ? ` &middot; ${escapeHtml(fcst.year)}` : ''}</div>
      </div>
    </div>`;
  })() : '';

  const kpis = kpiMetrics.map(splitTrailingYear).map((sy, i) => `
      <div class="kpi-box">
        <div class="kpi-accent" style="background:${CHART_COLORS[i % CHART_COLORS.length]};"></div>
        <div class="kpi-value" style="color:${CHART_COLORS[i % CHART_COLORS.length]};">${escapeHtml(sy.value || '—')}</div>
        <div class="kpi-label">${escapeHtml(kpiMetrics[i].label)}${sy.year ? ` &middot; ${escapeHtml(sy.year)}` : ''}</div>
      </div>`).join('');

  const structureRows = structureMetrics.map((m) => {
    const sy = splitTrailingYear(m);
    return `
          <tr class="data-row">
            <td class="col-metric">${escapeHtml(m.label)}${sy.year ? ` <span class="col-year">(${escapeHtml(sy.year)})</span>` : ''}</td>
            <td class="col-value">${escapeHtml(sy.value || '—')}</td>
          </tr>`;
  }).join('');

  // Every chartable metric becomes its own tile in a 2-column widget grid —
  // a real donut for Segment Breakdown / Share, a solid pie gauge (visually
  // distinct from the ring donut) for CAGR/growth-rate metrics, one bar-pair
  // tile per "before → after" trend (each trend gets its own half-width
  // tile, not lumped into one shared chart), and a ranked bar tile for
  // Market Share by Player. Nothing here is fabricated — a tile only exists
  // when the underlying data for it actually exists.
  const widgets: string[] = [];

  const segmentSlices = segmentMetric ? parseNamePercentList(segmentMetric.value) : [];
  if (segmentSlices.length >= 2) {
    widgets.push(buildBubbleWidget(segmentMetric!.label, segmentSlices));
  }

  // Every share-of-whole metric (up to 2) gets its own waffle grid — filled
  // dots = pct, the standard non-donut way to show "X% of a whole."
  shareMetrics.forEach((shareMetric, i) => {
    const sharePct = firstNumber(shareMetric.value) ?? 0;
    const color = CHART_COLORS[i % CHART_COLORS.length];
    widgets.push(buildWaffleWidget(shareMetric.label, sharePct, color, waffleCaption(shareMetric)));
  });

  // CAGR/growth-rate style percentages also become waffle grids — visually
  // distinct from the share waffles above via a different accent color.
  gaugeMetrics.forEach((m, i) => {
    const pct = Math.max(0, Math.min(100, firstNumber(m.value) ?? 0));
    const color = CHART_COLORS[(i + 2) % CHART_COLORS.length];
    widgets.push(buildWaffleWidget(m.label, pct, color, waffleCaption(m)));
  });

  // One bubble-comparison tile per trend metric — each sits in its own
  // half-width grid cell instead of being stacked into one shared list.
  trends.forEach((t, i) => {
    widgets.push(buildTrendBubbleWidget(t.label, t.points, CHART_COLORS[i % CHART_COLORS.length]));
  });

  if (marketShareMetric) {
    widgets.push(buildBubbleWidget('Market Share by Player', parseNamePercentList(marketShareMetric.value)));
  }

  // Grid column count picked to fit the ACTUAL widget count with zero
  // leftover blank cells wherever possible — a fixed 3 columns left 2 dead
  // cells for a 4-widget row (confirmed live 2026-09-18: "Average Blended
  // ASP" sat alone in a row with visible empty space beside it).
  const widgetCols = widgets.length <= 1 ? 1
    : widgets.length === 2 ? 2
    : widgets.length % 3 === 0 ? 3
    : widgets.length % 2 === 0 ? 2
    : 3;

  // Exact same proportions as the Desktop/agents/generate_table_image.py
  // reference (1100x530), scaled up 1.3636x to a 1500-wide canvas — same
  // header/KPI-column/section/chart padding and font-size ratios, at a
  // higher resolution, with real (non-hardcoded) data driving each part.
  // Height is intentionally NOT fixed: like the html2image reference (which
  // screenshots the rendered element, not a fixed canvas), the card sizes to
  // however much content it actually has — a 4-metric blog doesn't get the
  // same tall canvas as a 12-metric one, so there's no dead whitespace.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1132px; }
  body {
    background: #eef1f8;
    font-family: 'Plus Jakarta Sans', 'Segoe UI', Arial, sans-serif;
    padding: 16px;
  }
  .card {
    width: 100%;
    background: #f4f6fb;
    border-radius: 22px;
    overflow: hidden;
    box-shadow: 0 12px 48px rgba(37,42,90,0.18);
    display: flex;
    flex-direction: column;
  }
  .header {
    background: linear-gradient(120deg, #0e2153 0%, #234a92 100%);
    color: white;
    padding: 12px 30px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .header-eyebrow { font-size: 10.5px; font-weight: 800; letter-spacing: 1.4px; text-transform: uppercase; opacity: 0.65; margin-bottom: 4px; }
  .header-title { font-size: 24px; font-weight: 900; letter-spacing: 0.2px; }
  .header-sub { font-size: 14px; opacity: 0.85; margin-top: 3px; font-weight: 600; }
  .header-badge {
    background: rgba(255,255,255,0.18);
    border: 1px solid rgba(255,255,255,0.35);
    border-radius: 27px;
    padding: 8px 20px;
    font-size: 14px;
    font-weight: 800;
    letter-spacing: 0.8px;
  }

  /* Hero row — base value → CAGR → forecast value, one series at two points
     in time (same hue, two shades) instead of unrelated stat boxes. */
  .hero-row {
    display: flex;
    align-items: center;
    gap: 26px;
    background: #f7f8fc;
    border-radius: 14px;
    padding: 10px 24px;
    margin: 10px 16px 0;
  }
  .hero-tile { flex: 1; min-width: 0; }
  .hero-value { font-size: 25px; font-weight: 900; line-height: 1.1; letter-spacing: -0.3px; white-space: nowrap; }
  .hero-label { font-size: 11px; color: ${INK_SECONDARY}; font-weight: 700; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.3px; }
  .hero-connector { display: flex; flex-direction: column; align-items: center; gap: 5px; flex-shrink: 0; }
  .hero-arrow { font-size: 18px; color: #c3ccdb; font-weight: 700; }
  .hero-cagr {
    display: flex; align-items: center; gap: 5px;
    background: rgba(63,143,108,0.10);
    color: ${STATUS_GOOD};
    border-radius: 20px;
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 800;
    white-space: nowrap;
  }
  .hero-cagr-arrow { font-size: 10px; }
  /* align-items: flex-start (not stretch) — each column takes its own
     natural content height instead of being forced to match whichever
     column is tallest, which otherwise left dead blank space inside the
     shorter column (confirmed live 2026-09-18: a 2-widget grid stretched
     to match a 4-box KPI column left a big empty gap under the widgets). */
  .body { display: flex; align-items: flex-start; gap: 10px; padding: 10px 16px; background: #f4f6fb; }

  /* Left KPI column — each stat is its own floating rounded card */
  .kpi-col {
    width: 320px;
    min-width: 320px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .kpi-box {
    background: #f7f8fc;
    border-radius: 16px;
    padding: 18px 24px;
    text-align: left;
    position: relative;
    padding-left: 28px;
  }
  .kpi-accent { position: absolute; left: 12px; top: 18px; bottom: 18px; width: 4px; border-radius: 3px; }
  .kpi-value { font-size: 27px; font-weight: 900; line-height: 1.2; letter-spacing: -0.3px; }
  .kpi-label { font-size: 12.5px; color: #8592ab; margin-top: 5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }

  /* Right area: optional Market Structure table + the chart widget grid — same floating-card language as the KPI column */
  .right-area { flex: 1; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .widget-grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    align-content: start;
  }
  .widget {
    background: #f7f8fc;
    border-radius: 14px;
    padding: 10px 16px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-width: 0;
    --accent: #2563eb;
  }
  .structure-card { background: #f7f8fc; border-radius: 16px; overflow: hidden; }
  .section-label {
    padding: 13px 24px;
    font-size: 12.5px;
    font-weight: 800;
    color: #8592ab;
    text-transform: uppercase;
    letter-spacing: 0.7px;
  }
  table { width: 100%; border-collapse: collapse; }
  tr.data-row td { padding: 12px 24px; font-size: 16px; vertical-align: middle; }
  .col-metric { color: #3d5166; font-weight: 600; width: 46%; }
  .col-value { color: #1d4ed8; font-weight: 800; }

  .chart-title {
    font-size: 10.5px;
    font-weight: 800;
    color: #6b7a94;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 5px;
    padding-left: 8px;
    border-left: 3px solid var(--accent, #2563eb);
  }

  /* Packed bubble chart (Segment Breakdown, Market Share by Player) — leading entry gets a badge + ring */
  .bubble-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 6px; flex-wrap: wrap; flex: 1; padding-top: 6px; }
  .bubble-col { display: flex; flex-direction: column; align-items: center; gap: 5px; flex: 1; min-width: 44px; position: relative; }
  .bubble { border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .bubble-leading { box-shadow: 0 0 0 3px rgba(47,95,163,0.25); }
  .bubble-pct { color: #fff; font-size: 10.5px; font-weight: 900; }
  .bubble-name { font-size: 9px; font-weight: 700; color: ${INK_SECONDARY}; text-align: center; line-height: 1.15; }
  .leading-badge {
    background: rgba(63,143,108,0.12); color: ${STATUS_GOOD}; font-size: 8.5px; font-weight: 800;
    text-transform: uppercase; letter-spacing: 0.3px; border-radius: 8px; padding: 2px 7px; margin-bottom: 2px;
  }

  /* Waffle / dot-matrix grid (single share-of-whole percentages) */
  .waffle-wrap { display: flex; align-items: center; gap: 14px; }
  .waffle-grid { display: grid; grid-template-columns: repeat(10, 1fr); gap: 2.5px; width: 120px; }
  .waffle-dot { width: 9px; height: 9px; border-radius: 2px; }
  .waffle-pct { font-size: 22px; font-weight: 900; }
  .waffle-label { font-size: 10.5px; color: ${INK_SECONDARY}; font-weight: 700; margin-top: 2px; }

  /* Size-scaled bubble comparison (before → after trends) */
  .trend-bubble-row { display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; padding-top: 6px; }
  .trend-bubble-item { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .trend-bubble { border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 4px; }
  .trend-bubble-main { font-size: 10.5px; font-weight: 900; line-height: 1.1; }
  .trend-bubble-unit { font-size: 8px; font-weight: 700; opacity: 0.85; margin-top: 1px; }
  .trend-bubble-year { font-size: 10px; color: ${INK_SECONDARY}; font-weight: 700; }
  .trend-arrow { color: #c3ccdb; font-size: 16px; }

  /* Key Players — neutral chips (not color-coded; a company name isn't a data value) */
  .players-card { background: #f7f8fc; border-radius: 14px; margin: 0 16px; padding: 8px 16px; }
  .players-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
  .player-chip {
    display: inline-flex; align-items: center; gap: 6px;
    background: #ffffff;
    border: 1px solid rgba(11,18,32,0.08);
    border-radius: 18px;
    padding: 4px 11px;
    font-size: 11.5px;
    font-weight: 700;
    color: ${INK_PRIMARY};
    white-space: nowrap;
  }
  .player-dot { width: 5px; height: 5px; border-radius: 50%; background: #234a92; flex-shrink: 0; }

  .footer {
    background: #f4f6fb;
    padding: 8px 30px 10px;
    font-size: 11px;
    color: #9aabb8;
    display: flex;
    justify-content: space-between;
    border-top: 1px solid rgba(11,18,32,0.06);
    margin-top: 2px;
  }
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <div>
      <div class="header-eyebrow">Market Intelligence</div>
      <div class="header-title">Market at a Glance</div>
      <div class="header-sub">${escapeHtml(marketName)}</div>
    </div>
    <div class="header-badge">KEN RESEARCH</div>
  </div>

  ${heroHtml}

  <div class="body">
    ${kpis ? `<div class="kpi-col">${kpis}</div>` : ''}

    <div class="right-area">
      ${structureRows ? `<div class="structure-card"><div class="section-label">Market Structure</div><table>${structureRows}</table></div>` : ''}
      ${widgets.length ? `<div class="widget-grid" style="grid-template-columns: repeat(${widgetCols}, 1fr);">${widgets.join('')}</div>` : ''}
    </div>
  </div>

  ${keyPlayersMetric ? `
  <div class="players-card">
    <div class="section-label">Key Players</div>
    <div class="players-list">
      ${parseNameList(keyPlayersMetric.value).map((name) => `<span class="player-chip"><span class="player-dot"></span>${escapeHtml(name)}</span>`).join('')}
    </div>
  </div>` : ''}

  <div class="footer">
    <span>Source: Ken Research Analysis</span>
    <span>kenresearch.com</span>
  </div>
</div>
</body>
</html>`;
}

/**
 * Render the snapshot HTML to a local PNG via a headless Playwright page
 * (no new Python/html2image dependency — this project already ships
 * Playwright for browser automation).
 */
async function renderSnapshotPng(html: string, outPath: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    // Tall viewport so nothing clips before we measure — the final PNG is an
    // ELEMENT screenshot of .card, cropped to its actual rendered height,
    // not the viewport itself.
    const page = await browser.newPage({ viewport: { width: 1544, height: 2000 } });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
    await page.locator('.card').screenshot({ path: outPath });
  } finally {
    await browser.close();
  }
}

/**
 * Build the snapshot image from a market name + the raw "Image Data"
 * sheet/prompt text, render it, upload it to Google Drive, and return the
 * public hotlink URL — ready to drop into the article's
 * <figure><img src="..."> in place of YOUR_IMAGE_URL_HERE.
 */
export async function generateAndUploadSnapshotImage(params: {
  marketName: string;
  imageData: string;
  driveFolderId?: string;
}): Promise<{ url: string; fileId: string; metrics: SnapshotMetric[] }> {
  const metrics = parseSnapshotMetrics(params.imageData);
  if (metrics.length === 0) {
    throw new Error('No metrics parsed from Image Data — nothing to render.');
  }

  const html = buildSnapshotHtml(params.marketName, metrics);

  const slug = params.marketName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'market-snapshot';
  const outPath = path.join(os.tmpdir(), `${slug}_snapshot_${Date.now()}.png`);

  await renderSnapshotPng(html, outPath);

  try {
    const { url, fileId } = await uploadFileToGoogleDrive(outPath, params.driveFolderId);
    return { url, fileId, metrics };
  } finally {
    fs.unlink(outPath, () => {});
  }
}
