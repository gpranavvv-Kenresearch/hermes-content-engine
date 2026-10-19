/**
 * blogLandscapeImageAgent.ts — renders the SECOND mid-blog image, "Forecast
 * Outlook & Market Landscape": Forecast Growth (bubble comparison) +
 * Competitive Landscape (packed bubble chart) on top, Growth Drivers (impact
 * meter) + Regional Heat Map below. Fills the article's second placeholder,
 * <img src="YOUR_IMAGE_URL_HERE_2">, produced by the "Key Qualitative
 * Insights for Image 2" block in blogGenAgent.ts's master prompt.
 *
 * Deliberately avoids bar/line/pie/donut/column charts (2026-09-28 design
 * requirement) — uses proportional bubbles, a dot-based impact meter, and
 * color-intensity heat-map tiles instead.
 *
 * Reuses the base/forecast/CAGR figures already parsed for the FIRST image
 * (blogSnapshotImageAgent.ts's SnapshotMetric[]) via findHeroMetrics(), rather
 * than asking the LLM to repeat them — the LLM only needs to supply the new
 * qualitative content (drivers, competitive shares, regional shares).
 *
 * Same visual language as blogSnapshotImageAgent.ts (CHART_COLORS, ink
 * tokens, Playwright HTML->PNG render, Google Drive upload) — locked design
 * confirmed live in this session (bubble-demo.png).
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { uploadFileToGoogleDrive } from '../utils/googleDriveUpload.js';
import {
  SnapshotMetric, NamedShare, findHeroMetrics, splitTrailingYear,
  parseNamePercentList, escapeHtml, CHART_COLORS, STATUS_GOOD, INK_PRIMARY, INK_SECONDARY,
} from './blogSnapshotImageAgent.js';

export interface LandscapeData {
  drivers: string[];
  competitive: NamedShare[];
  regions: NamedShare[];
}

// Same citation-chip guard as blogSnapshotImageAgent.ts's parser — defensive
// in case a leaked "kenresearch.com +1" chip lands inside this block too.
const CITATION_CHIP_LINE_RE = /^(?:(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\s*\+\d+)?|\+\d+)$/i;

/**
 * Parse the "Key Qualitative Insights for Image 2" block:
 *   Growth Drivers: Driver 1; Driver 2; Driver 3
 *   Competitive Landscape: Name1 X%, Name2 Y%, Name3 Z%
 *   Regional Landscape: Region1 X%, Region2 Y%, Region3 Z%
 * Each line is optional — a widget only renders when its data exists.
 */
export function parseLandscapeData(imageData2: string): LandscapeData {
  const lines = imageData2
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !CITATION_CHIP_LINE_RE.test(l));

  let drivers: string[] = [];
  let competitive: NamedShare[] = [];
  let regions: NamedShare[] = [];

  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const label = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (/growth drivers?/i.test(label)) {
      drivers = value.split(';').map((s) => s.trim()).filter(Boolean);
    } else if (/competitive landscape/i.test(label)) {
      competitive = parseNamePercentList(value);
    } else if (/regional landscape|regional (heat\s*map|spotlight)/i.test(label)) {
      regions = parseNamePercentList(value);
    }
  }

  return { drivers, competitive, regions };
}

function firstNumber(s: string): number | null {
  const m = s.replace(/,/g, '').match(/[\d]+\.?\d*/);
  return m ? parseFloat(m[0]) : null;
}

// Splits "USD 875.0 million" -> {main: "USD 875.0", unit: "million"} so a
// bubble's text stays two short lines regardless of whether the report used
// an abbreviated ("USD 875.0M") or spelled-out ("USD 875.0 million") unit —
// keeps text width consistent and inside the circle either way.
function splitUnitWord(value: string): { main: string; unit: string } {
  const m = value.match(/^(.*?)\s+(million|billion|thousand|trillion)$/i);
  return m ? { main: m[1].trim(), unit: m[2] } : { main: value, unit: '' };
}

/**
 * Forecast Growth as a proportional BUBBLE COMPARISON — two circles (base,
 * forecast), same hue two shades ("one series, two points in time"),
 * connected by a plain arrow. No axis, no line, no bar.
 */
function bubbleComparisonSvg(baseLabel: string, baseValue: string, forecastLabel: string, forecastValue: string): string {
  const w = 420, h = 150;
  const rBase = 30, rForecast = 54;
  const cx1 = 95, cx2 = 300, cy = 78;
  const base = splitUnitWord(baseValue);
  const fcst = splitUnitWord(forecastValue);
  const bubbleText = (cx: number, main: string, unit: string, mainSize: number, unitSize: number, color: string) => `
      <text x="${cx}" y="${cy - (unit ? 3 : -4)}" text-anchor="middle" font-family="'Plus Jakarta Sans', Arial, sans-serif" font-size="${mainSize}" font-weight="900" fill="${color}">${escapeHtml(main)}</text>
      ${unit ? `<text x="${cx}" y="${cy + unitSize + 3}" text-anchor="middle" font-family="'Plus Jakarta Sans', Arial, sans-serif" font-size="${unitSize}" font-weight="700" fill="${color}" opacity="0.85">${escapeHtml(unit)}</text>` : ''}`;
  return `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <circle cx="${cx1}" cy="${cy}" r="${rBase}" fill="#8aa6cf" opacity="0.85"/>
      <circle cx="${cx2}" cy="${cy}" r="${rForecast}" fill="${CHART_COLORS[0]}"/>
      ${bubbleText(cx1, base.main, base.unit, 10, 8, '#1e3a5f')}
      ${bubbleText(cx2, fcst.main, fcst.unit, 12, 9, '#ffffff')}
      <text x="${cx1}" y="${cy + rBase + 20}" text-anchor="middle" font-family="'Plus Jakarta Sans', Arial, sans-serif" font-size="11" font-weight="700" fill="${INK_SECONDARY}">${escapeHtml(baseLabel)}</text>
      <text x="${cx2}" y="${cy + rForecast + 20}" text-anchor="middle" font-family="'Plus Jakarta Sans', Arial, sans-serif" font-size="11" font-weight="700" fill="${INK_SECONDARY}">${escapeHtml(forecastLabel)}</text>
      <path d="M ${cx1 + rBase + 10} ${cy} L ${cx2 - rForecast - 10} ${cy}" stroke="#c3ccdb" stroke-width="2" marker-end="url(#arrow)"/>
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#c3ccdb"/>
        </marker>
      </defs>
    </svg>`;
}

/**
 * Competitive Landscape as a packed BUBBLE chart — circle AREA proportional
 * to share % (radius = k * sqrt(pct)), one distinct color per company
 * (identity), name+% labeled per bubble. No bar/pie/donut.
 */
function competitiveBubbles(items: NamedShare[]): string {
  const sorted = [...items].sort((a, b) => b.pct - a.pct);
  const maxPct = Math.max(...sorted.map((i) => i.pct), 0.0001);
  const k = 40 / Math.sqrt(maxPct);
  return `<div class="bubble-row">${sorted.map((s, i) => {
    const r = Math.max(16, Math.round(k * Math.sqrt(s.pct)));
    return `
    <div class="bubble-col">
      <div class="bubble" style="width:${r * 2}px;height:${r * 2}px;background:${CHART_COLORS[i % CHART_COLORS.length]};">
        <span class="bubble-pct">${s.pct}%</span>
      </div>
      <div class="bubble-name">${escapeHtml(s.name)}</div>
    </div>`;
  }).join('')}</div>`;
}

/** 3-dot impact meter — filled dots = relative emphasis. Level reflects the LLM's own list order (most-cited drivers first), never an invented score. */
function impactMeter(level: number, color: string): string {
  return `<span class="impact-meter">${[1, 2, 3].map((i) =>
    `<span class="impact-dot" style="background:${i <= level ? color : '#dbe2ee'};"></span>`).join('')}</span>`;
}

function driverListWithImpact(items: string[], color: string): string {
  const half = Math.ceil(items.length / 2);
  return items.map((t, i) => `
    <div class="driver-row">
      <span class="driver-dot" style="background:${color};"></span>
      <span class="driver-text">${escapeHtml(t)}</span>
      ${impactMeter(i < half ? 3 : 2, color)}
    </div>`).join('');
}

/** Regional Heat Map — a tile grid where fill opacity (same hue) is proportional to share, the standard heat-map convention, without needing real country-border SVG data. */
function heatMapGrid(items: NamedShare[]): string {
  const max = Math.max(...items.map((i) => i.pct), 0.0001);
  return `<div class="heatmap-grid">${items.map((r) => {
    const intensity = 0.18 + (r.pct / max) * 0.72;
    const textColor = intensity > 0.55 ? '#ffffff' : INK_PRIMARY;
    return `
    <div class="heat-tile" style="background: rgba(47,95,163,${intensity.toFixed(2)}); color:${textColor};">
      <div class="heat-pct">${r.pct}%</div>
      <div class="heat-name">${escapeHtml(r.name)}</div>
    </div>`;
  }).join('')}</div>`;
}

function statChipRow(items: { label: string; value: string; color: string }[]): string {
  return `<div class="stat-chip-row">${items.map((s) => `
    <div class="stat-chip">
      <div class="stat-chip-value" style="color:${s.color};">${escapeHtml(s.value)}</div>
      <div class="stat-chip-label">${escapeHtml(s.label)}</div>
    </div>`).join('')}</div>`;
}

function incrementalGrowth(base: SnapshotMetric, forecast: SnapshotMetric): string | null {
  const baseNum = firstNumber(splitTrailingYear(base).value);
  const forecastNum = firstNumber(splitTrailingYear(forecast).value);
  if (baseNum === null || forecastNum === null) return null;
  // Reuse whatever unit/currency prefix the forecast value used (e.g. "USD", "USD 1,159.2 million" -> "USD").
  const unitMatch = splitTrailingYear(forecast).value.match(/^([A-Za-z]+)\s/);
  const unit = unitMatch ? `${unitMatch[1]} ` : '';
  const suffixMatch = splitTrailingYear(forecast).value.match(/(million|billion|thousand|trillion)\b/i);
  const suffix = suffixMatch ? ` ${suffixMatch[1]}` : '';
  return `${unit}${(forecastNum - baseNum).toFixed(1)}${suffix}`;
}

/**
 * Build the "Forecast Outlook & Market Landscape" card HTML. `heroMetrics`
 * comes from findHeroMetrics() run on the FIRST image's already-parsed
 * SnapshotMetric[] (base/forecast/CAGR) — this image never re-derives those
 * from the LLM. Any panel whose underlying data is empty is simply omitted
 * (no fabricated content), matching blogSnapshotImageAgent.ts's convention.
 */
export function buildLandscapeHtml(
  marketName: string,
  heroMetrics: { base?: SnapshotMetric; forecast?: SnapshotMetric; cagr?: SnapshotMetric },
  data: LandscapeData
): string {
  const { base, forecast, cagr } = heroMetrics;
  const hasTrajectory = !!(base && forecast);
  const baseSplit = base ? splitTrailingYear(base) : undefined;
  const forecastSplit = forecast ? splitTrailingYear(forecast) : undefined;

  const growthPanel = hasTrajectory ? `
    <div class="panel" style="--accent:${CHART_COLORS[0]};">
      <div class="panel-title">Forecast Growth${baseSplit?.year && forecastSplit?.year ? ` (${escapeHtml(baseSplit.year)}&ndash;${escapeHtml(forecastSplit.year)})` : ''}</div>
      ${bubbleComparisonSvg(baseSplit!.year || 'Base', baseSplit!.value, forecastSplit!.year || 'Forecast', forecastSplit!.value)}
      ${statChipRow([
        ...(cagr ? [{ label: 'CAGR', value: cagr.value, color: STATUS_GOOD }] : []),
        ...(incrementalGrowth(base!, forecast!) ? [{ label: 'Incremental Growth', value: incrementalGrowth(base!, forecast!)!, color: CHART_COLORS[0] }] : []),
      ])}
    </div>` : '';

  const competitivePanel = data.competitive.length ? `
    <div class="panel" style="--accent:${CHART_COLORS[3]};">
      <div class="panel-title">Competitive Landscape</div>
      ${competitiveBubbles(data.competitive)}
    </div>` : '';

  const driversPanel = data.drivers.length ? `
    <div class="panel" style="--accent:${CHART_COLORS[1]};">
      <div class="panel-title">Growth Drivers &mdash; Impact</div>
      ${driverListWithImpact(data.drivers, CHART_COLORS[1])}
    </div>` : '';

  const regionsPanel = data.regions.length ? `
    <div class="panel" style="--accent:${CHART_COLORS[0]};">
      <div class="panel-title">Regional Heat Map &mdash; Share by Country</div>
      ${heatMapGrid(data.regions)}
    </div>` : '';

  const topRow = (growthPanel || competitivePanel) ? `<div class="row">${growthPanel}${competitivePanel}</div>` : '';
  const bottomRow = (driversPanel || regionsPanel) ? `<div class="row">${driversPanel}${regionsPanel}</div>` : '';

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
  body { background: #eef1f8; font-family: 'Plus Jakarta Sans', 'Segoe UI', Arial, sans-serif; padding: 16px; }
  .card { width: 100%; background: #f4f6fb; border-radius: 22px; overflow: hidden; box-shadow: 0 12px 48px rgba(37,42,90,0.18); display: flex; flex-direction: column; }
  .header { background: linear-gradient(120deg, #0e2153 0%, #234a92 100%); color: white; padding: 12px 30px; display: flex; align-items: center; justify-content: space-between; }
  .header-eyebrow { font-size: 10.5px; font-weight: 800; letter-spacing: 1.4px; text-transform: uppercase; opacity: 0.65; margin-bottom: 4px; }
  .header-title { font-size: 24px; font-weight: 900; letter-spacing: 0.2px; }
  .header-sub { font-size: 14px; opacity: 0.85; margin-top: 3px; font-weight: 600; }
  .header-source { font-size: 11px; opacity: 0.7; font-weight: 700; letter-spacing: 0.3px; }

  .row { display: flex; align-items: stretch; gap: 10px; padding: 10px 16px; background: #f4f6fb; }
  .row:first-of-type { padding-top: 14px; }
  .row:last-of-type { padding-bottom: 16px; }
  .panel { flex: 1; background: #f7f8fc; border-radius: 14px; padding: 14px 20px; display: flex; flex-direction: column; min-width: 0; }
  .panel-title { font-size: 10.5px; font-weight: 800; color: #6b7a94; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 7px; padding-left: 8px; border-left: 3px solid var(--accent, #2563eb); }

  .stat-chip-row { display: flex; gap: 8px; margin-top: 8px; }
  .stat-chip { flex: 1; background: #ffffff; border-radius: 10px; padding: 7px 10px; text-align: center; }
  .stat-chip-value { font-size: 13px; font-weight: 900; line-height: 1.15; }
  .stat-chip-label { font-size: 9px; color: #8592ab; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; margin-top: 2px; }

  .driver-row { display: flex; align-items: flex-start; gap: 7px; margin-bottom: 7px; }
  .driver-dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 4px; flex-shrink: 0; }
  .driver-text { font-size: 11.5px; color: ${INK_PRIMARY}; font-weight: 600; line-height: 1.35; flex: 1; }
  .impact-meter { display: inline-flex; gap: 3px; flex-shrink: 0; margin-top: 4px; margin-left: 6px; }
  .impact-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }

  .heatmap-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .heat-tile { border-radius: 8px; padding: 10px 8px; text-align: center; }
  .heat-pct { font-size: 15px; font-weight: 900; }
  .heat-name { font-size: 10px; font-weight: 700; margin-top: 2px; opacity: 0.9; }

  .bubble-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 6px; flex: 1; padding-top: 8px; }
  .bubble-col { display: flex; flex-direction: column; align-items: center; gap: 6px; flex: 1; min-width: 0; }
  .bubble { border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .bubble-pct { color: #fff; font-size: 12px; font-weight: 900; }
  .bubble-name { font-size: 9.5px; font-weight: 700; color: ${INK_SECONDARY}; text-align: center; line-height: 1.2; }
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <div>
      <div class="header-eyebrow">Market Intelligence</div>
      <div class="header-title">Forecast Outlook &amp; Market Landscape</div>
      <div class="header-sub">${escapeHtml(marketName)}</div>
    </div>
    <div class="header-source">Source: Ken Research</div>
  </div>
  ${topRow}
  ${bottomRow}
</div>
</body>
</html>`;
}

async function renderLandscapePng(html: string, outPath: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1400 } });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
    await page.locator('.card').screenshot({ path: outPath });
  } finally {
    await browser.close();
  }
}

/**
 * Build the second mid-blog image from the FIRST image's already-parsed
 * metrics (for base/forecast/CAGR) plus the "Key Qualitative Insights for
 * Image 2" raw text, render it, upload it to Google Drive, and return the
 * public hotlink URL for the article's second placeholder,
 * YOUR_IMAGE_URL_HERE_2.
 */
export async function generateAndUploadLandscapeImage(params: {
  marketName: string;
  heroSourceMetrics: SnapshotMetric[];
  imageData2: string;
  driveFolderId?: string;
}): Promise<{ url: string; fileId: string }> {
  const heroMetrics = findHeroMetrics(params.heroSourceMetrics);
  const data = parseLandscapeData(params.imageData2);

  const hasAnyContent = !!(heroMetrics.base && heroMetrics.forecast) || data.drivers.length || data.competitive.length || data.regions.length;
  if (!hasAnyContent) {
    throw new Error('No landscape data parsed (no forecast pair, drivers, competitive shares, or regional shares) — nothing to render.');
  }

  const html = buildLandscapeHtml(params.marketName, heroMetrics, data);

  const slug = params.marketName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'market-landscape';
  const outPath = path.join(os.tmpdir(), `${slug}_landscape_${Date.now()}.png`);

  await renderLandscapePng(html, outPath);

  try {
    const { url, fileId } = await uploadFileToGoogleDrive(outPath, params.driveFolderId);
    return { url, fileId };
  } finally {
    fs.unlink(outPath, () => {});
  }
}
