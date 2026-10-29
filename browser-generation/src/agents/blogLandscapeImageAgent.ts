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
 * LOCKED DESIGN (approved 2026-10-29). Wide horizontal card, 1132px, about 1.67:1: Forecast Growth + Key Players orbit on top,
 * Growth Drivers + Regional Heat Map + Key Takeaways below. Nothing the data supplies may be left out: every driver, player,
 * region (plus "Other regions"), stat chip and takeaway must be drawn. Do not change the layout, sizes or sections without the
 * user's approval; tests/images.test.ts ("landscape image is locked") guards it.
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
  parseNamePercentList, escapeHtml, CHART_COLORS, STATUS_GOOD, INK_PRIMARY, INK_SECONDARY, playerOrbit,
} from './blogSnapshotImageAgent.js';

export interface LandscapeData {
  drivers: string[];
  competitive: NamedShare[];
  /** Competitor names with no share figures. Shown as a plain list, never given invented shares. */
  competitiveNames?: string[];
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
  let competitiveNames: string[] = [];
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
      if (competitive.length === 0) {
        competitiveNames = value.split(/[;,]/).map((n) => n.replace(/\s*\(?\d[\d.]*\s*%\)?/g, '').trim()).filter((n) => n.length > 1 && n.length <= 60).slice(0, 8);
      }
    } else if (/regional landscape|regional (heat\s*map|spotlight)/i.test(label)) {
      regions = parseNamePercentList(value);
    }
  }

  return { drivers, competitive, competitiveNames, regions };
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
  // viewBox is a design grid; the SVG scales to its panel. The height leaves room for the year label under the big bubble.
  const w = 400, h = 184;
  const rBase = 32, rForecast = 58;
  const cx1 = 90, cx2 = 290, cy = 84;
  const base = splitUnitWord(baseValue);
  const fcst = splitUnitWord(forecastValue);
  const bubbleText = (cx: number, main: string, unit: string, mainSize: number, unitSize: number, color: string) => `
      <text x="${cx}" y="${cy - (unit ? 3 : -4)}" text-anchor="middle" font-family="'Plus Jakarta Sans', Arial, sans-serif" font-size="${mainSize}" font-weight="900" fill="${color}">${escapeHtml(main)}</text>
      ${unit ? `<text x="${cx}" y="${cy + unitSize + 3}" text-anchor="middle" font-family="'Plus Jakarta Sans', Arial, sans-serif" font-size="${unitSize}" font-weight="700" fill="${color}" opacity="0.85">${escapeHtml(unit)}</text>` : ''}`;
  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:400px;height:auto;display:block;margin:0 auto;">
      <circle cx="${cx1}" cy="${cy}" r="${rBase}" fill="#8aa6cf" opacity="0.85"/>
      <circle cx="${cx2}" cy="${cy}" r="${rForecast}" fill="${CHART_COLORS[0]}"/>
      ${bubbleText(cx1, base.main, base.unit, 11, 9, '#1e3a5f')}
      ${bubbleText(cx2, fcst.main, fcst.unit, 13.5, 10.5, '#ffffff')}
      <text x="${cx1}" y="${cy + rBase + 20}" text-anchor="middle" font-family="'Plus Jakarta Sans', Arial, sans-serif" font-size="14" font-weight="700" fill="${INK_SECONDARY}">${escapeHtml(baseLabel)}</text>
      <text x="${cx2}" y="${cy + rForecast + 20}" text-anchor="middle" font-family="'Plus Jakarta Sans', Arial, sans-serif" font-size="14" font-weight="700" fill="${INK_SECONDARY}">${escapeHtml(forecastLabel)}</text>
      <path d="M ${cx1 + rBase + 10} ${cy} L ${cx2 - rForecast - 10} ${cy}" stroke="#c3ccdb" stroke-width="2" marker-end="url(#arrow)"/>
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#c3ccdb"/>
        </marker>
      </defs>
    </svg>`;
}

/**
 * Growth driver strength as a RING BADGE: three concentric rings, one more filled per impact step. Level reflects the
 * LLM's own list order (most-cited drivers first), never an invented score.
 */
function ringBadge(level: number, color: string): string {
  const rings = [13, 9, 5];
  return `<svg class="ring" viewBox="0 0 30 30" width="30" height="30">${rings.map((r, i) =>
    `<circle cx="15" cy="15" r="${r}" fill="none" stroke="${i < level ? color : '#dbe2ee'}" stroke-width="3"/>`).join('')}</svg>`;
}

function driverCards(items: string[], color: string): string {
  const half = Math.ceil(items.length / 2);
  return `<div class="driver-stack">${items.map((t, i) => {
    const level = i < half ? 3 : 2;
    return `
    <div class="driver-card">
      ${ringBadge(level, color)}
      <span class="driver-text">${escapeHtml(t)}</span>
      <span class="driver-pill" style="color:${color};">${level === 3 ? 'High' : 'Medium'}</span>
    </div>`;
  }).join('')}</div>`;
}

interface MosaicTile { name: string; pct: number; other?: boolean }

/** Regions plus whatever share is left over ("Other regions"), as a TREEMAP-style mosaic: block area is the share, same-hue intensity follows the share. */
function regionTiles(items: NamedShare[]): MosaicTile[] {
  const sorted = [...items].sort((a, b) => b.pct - a.pct);
  const sum = sorted.reduce((s, i) => s + i.pct, 0);
  const rest = sum < 99.5 ? Math.round((100 - sum) * 10) / 10 : 0;
  return rest > 0 ? [...sorted, { name: 'Other regions', pct: rest, other: true }] : sorted;
}

function regionMosaic(items: NamedShare[]): string {
  const tiles = regionTiles(items);
  const max = Math.max(...tiles.filter((t) => !t.other).map((t) => t.pct), 0.0001);
  const style = (t: MosaicTile) => {
    if (t.other) return `background: repeating-linear-gradient(135deg,#e6ebf4,#e6ebf4 6px,#eef1f8 6px,#eef1f8 12px); color:${INK_SECONDARY};`;
    const intensity = 0.2 + (t.pct / max) * 0.7;
    return `background: rgba(47,95,163,${intensity.toFixed(2)}); color:${intensity > 0.55 ? '#ffffff' : INK_PRIMARY};`;
  };
  const [first, ...others] = tiles;
  const total = tiles.reduce((s, t) => s + t.pct, 0);
  const big = `<div class="mosaic-tile mosaic-big" style="flex:${(first!.pct / total).toFixed(4)};${style(first!)}"><div class="mosaic-pct">${first!.pct}%</div><div class="mosaic-name">${escapeHtml(first!.name)}</div></div>`;
  const othersSum = others.reduce((s, t) => s + t.pct, 0);
  const col = others.length ? `<div class="mosaic-col" style="flex:${(othersSum / total).toFixed(4)};">${others.map((t) =>
    `<div class="mosaic-tile mosaic-small" style="flex:${(t.pct / othersSum).toFixed(4)};${style(t)}"><span class="mosaic-pct-s">${t.pct}%</span><span class="mosaic-name-s">${escapeHtml(t.name)}</span></div>`).join('')}</div>` : '';
  return `<div class="mosaic">${big}${col}</div>`;
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

/** Forecast value divided by base value, e.g. "1.75x". Null when either is missing or the base is not positive. */
function growthMultiple(base: SnapshotMetric, forecast: SnapshotMetric): string | null {
  const b = firstNumber(splitTrailingYear(base).value), f = firstNumber(splitTrailingYear(forecast).value);
  if (b === null || f === null || b <= 0) return null;
  return `${(f / b).toFixed(2)}x`;
}

/** Plain-language takeaways written only from the data this image already shows; a line is dropped when its data is missing. */
function takeawayItems(
  base: SnapshotMetric | undefined, forecast: SnapshotMetric | undefined, data: LandscapeData,
): string[] {
  const b = (s: string) => `<b>${escapeHtml(s)}</b>`;
  const out: string[] = [];
  if (base && forecast) {
    const bs = splitTrailingYear(base), fs = splitTrailingYear(forecast), mult = growthMultiple(base, forecast);
    out.push(`The market ${mult ? `grows ${b(mult)} ` : 'moves '}from ${b(bs.value)}${bs.year ? ` in ${escapeHtml(bs.year)}` : ''} to ${b(fs.value)}${fs.year ? ` in ${escapeHtml(fs.year)}` : ''}.`);
  }
  if (data.drivers.length) out.push(`${b(data.drivers[0]!)} is the leading growth driver.`);
  const tiles = regionTiles(data.regions).filter((t) => !t.other);
  if (tiles.length >= 2) {
    const sum = Math.round((tiles[0]!.pct + tiles[1]!.pct) * 10) / 10;
    out.push(`${b(tiles[0]!.name)} and ${b(tiles[1]!.name)} together hold ${b(`${sum}%`)} of the regional share.`);
  } else if (tiles.length === 1) out.push(`${b(tiles[0]!.name)} holds ${b(`${tiles[0]!.pct}%`)} of the regional share.`);
  if (data.competitive.length) {
    const top = [...data.competitive].sort((x, y) => y.pct - x.pct)[0]!;
    out.push(`${b(top.name)} leads the competitive landscape with ${b(`${top.pct}%`)} share.`);
  } else if (data.competitiveNames?.length) {
    const names = data.competitiveNames.slice(0, 3).map(b);
    out.push(`Key players include ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}.`);
  }
  return out;
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
        ...(growthMultiple(base!, forecast!) ? [{ label: 'Growth Multiple', value: growthMultiple(base!, forecast!)!, color: CHART_COLORS[1] }] : []),
      ])}
    </div>` : '';

  const playerNodes = data.competitive.length
    ? [...data.competitive].sort((a, b) => b.pct - a.pct).map((c) => ({ name: c.name, pct: c.pct }))
    : (data.competitiveNames ?? []).map((name) => ({ name }));
  const competitivePanel = playerNodes.length ? `
    <div class="panel" style="--accent:${CHART_COLORS[3]};">
      <div class="panel-title">${data.competitive.length ? 'Competitive Landscape' : 'Key Players'}</div>
      ${playerOrbit(playerNodes)}
    </div>` : '';

  const driversPanel = data.drivers.length ? `
    <div class="panel" style="--accent:${CHART_COLORS[1]};">
      <div class="panel-title">Growth Drivers &mdash; Impact</div>
      ${driverCards(data.drivers, CHART_COLORS[1]!)}
    </div>` : '';

  const regionsPanel = data.regions.length ? `
    <div class="panel" style="--accent:${CHART_COLORS[0]};">
      <div class="panel-title">Regional Heat Map &mdash; Share by Region</div>
      ${regionMosaic(data.regions)}
    </div>` : '';

  const takeaways = takeawayItems(base, forecast, data);
  const takeawayPanel = takeaways.length ? `
    <div class="panel" style="--accent:${STATUS_GOOD};">
      <div class="panel-title">Key Takeaways</div>
      <div class="takeaway-grid">${takeaways.map((t, i) => `
        <div class="takeaway"><span class="takeaway-num" style="background:${CHART_COLORS[i % CHART_COLORS.length]};">${i + 1}</span><span class="takeaway-text">${t}</span></div>`).join('')}
      </div>
    </div>` : '';

  const topRow = (growthPanel || competitivePanel) ? `<div class="row">${growthPanel}${competitivePanel}</div>` : '';
  const bottomRow = (driversPanel || regionsPanel || takeawayPanel) ? `<div class="row">${driversPanel}${regionsPanel}${takeawayPanel}</div>` : '';

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
  .header-source { white-space: nowrap; flex-shrink: 0; margin-left: 18px; font-size: 11px; opacity: 0.7; font-weight: 700; letter-spacing: 0.3px; }

  .row { display: flex; align-items: stretch; gap: 10px; padding: 10px 16px; background: #f4f6fb; }
  .row:first-of-type { padding-top: 14px; }
  .row:last-of-type { padding-bottom: 16px; }
  .panel { flex: 1 1 0; background: #f7f8fc; border-radius: 14px; padding: 14px 20px; display: flex; flex-direction: column; min-width: 0; }
  .panel-title { font-size: 10.5px; font-weight: 800; color: #6b7a94; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 7px; padding-left: 8px; border-left: 3px solid var(--accent, #2563eb); }

  .stat-chip-row { display: flex; gap: 8px; margin-top: 8px; }
  .stat-chip { flex: 1; background: #ffffff; border-radius: 10px; padding: 7px 10px; text-align: center; }
  .stat-chip-value { font-size: 13px; font-weight: 900; line-height: 1.15; }
  .stat-chip-label { font-size: 9px; color: #8592ab; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; margin-top: 2px; }

  .driver-stack { display: flex; flex-direction: column; gap: 6px; flex: 1; }
  .driver-card { flex: 1; display: flex; align-items: center; gap: 10px; background: #ffffff; border-radius: 10px; padding: 5px 12px; }
  .ring { flex-shrink: 0; }
  .driver-text { font-size: 11.5px; color: ${INK_PRIMARY}; font-weight: 600; line-height: 1.35; flex: 1; }
  .driver-pill { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.4px; white-space: nowrap; flex-shrink: 0; }

  .mosaic { display: flex; gap: 5px; flex: 1; min-height: 130px; }
  .mosaic-col { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .mosaic-tile { border-radius: 8px; min-width: 0; }
  .mosaic-big { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 8px; }
  .mosaic-pct { font-size: 24px; font-weight: 900; line-height: 1.1; }
  .mosaic-name { font-size: 11px; font-weight: 700; margin-top: 3px; opacity: 0.92; }
  .mosaic-small { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 4px 8px; text-align: center; min-height: 0; }
  .mosaic-pct-s { font-size: 14px; font-weight: 900; }
  .mosaic-name-s { font-size: 10px; font-weight: 700; opacity: 0.92; }

  .takeaway-grid { display: flex; flex-direction: column; gap: 6px; flex: 1; }
  .takeaway { flex: 1; display: flex; align-items: center; gap: 10px; background: #ffffff; border-radius: 10px; padding: 6px 12px; }
  .takeaway-num { width: 20px; height: 20px; border-radius: 50%; color: #fff; font-size: 10.5px; font-weight: 900; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .takeaway-text { font-size: 11.5px; color: ${INK_PRIMARY}; font-weight: 600; line-height: 1.35; }
  .takeaway-text b { font-weight: 900; }
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
    const page = await browser.newPage({ viewport: { width: 1200, height: 1400 }, deviceScaleFactor: 2 });
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
