/**
 * Google Trends browser fetcher (test build).
 *
 *   npm run trends:login                      one-time: log in by hand to a DEDICATED Google account
 *   npm run trends:fetch -- --q "óleo lubrificante" --geo BR [--date "today 12-m"] [--headless]
 *
 * Opens the Explore page on its own persistent Chrome profile (.sessions/google-trends),
 * clicks every download icon on the page, saves the CSVs, parses them and appends one
 * line per run to .cache/signals/trends/log.jsonl. Never guesses: a section that did not
 * download is recorded as NOT_DOWNLOADED, a blocked page as SIGN_IN_REQUIRED / THROTTLED.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';

const PROFILE_DIR = path.resolve('.sessions/google-trends');
const OUT_ROOT = path.resolve('.cache/signals/trends');

export type RunStatus = 'OK' | 'PARTIAL' | 'SIGN_IN_REQUIRED' | 'THROTTLED' | 'NO_DOWNLOADS' | 'ERROR';
export type SectionKind = 'interest_over_time' | 'interest_by_region' | 'top_queries' | 'rising_queries' | 'related_queries' | 'related_topics' | 'unknown';

export interface SavedFile {
  kind: SectionKind;
  file: string;
  header: string[];
  rows: Record<string, string>[];
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export async function openTrendsContext(headless: boolean): Promise<BrowserContext> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    // Google refuses sign-in on browsers flagged as automated.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
  });
}

async function login(): Promise<void> {
  const ctx = await openTrendsContext(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://trends.google.com/explore', { waitUntil: 'domcontentloaded' });
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log('A Chrome window is open on Google Trends.');
  console.log('  1. Sign in with a DEDICATED Google account (not the company account).');
  console.log('  2. Open any Explore search and check that the related queries show.');
  console.log('  3. Come back here and press Enter. The session stays in the profile.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter when done... ');
  rl.close();
  await ctx.close();
}

/** Minimal CSV parser (quoted fields, escaped quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function classify(fileName: string, header: string[]): SectionKind {
  const f = fileName.toLowerCase();
  const h = header.join(',').toLowerCase();
  if (f.includes('rising')) return 'rising_queries';
  if (f.includes('top') && f.includes('quer')) return 'top_queries';
  if (f.includes('time_series') || f.includes('multitimeline') || /^(time|week|day|month)\b/.test(h)) return 'interest_over_time';
  if (f.includes('geo') || f.includes('region') || /^(region|country|subregion|metro|city)\b/.test(h)) return 'interest_by_region';
  if (f.includes('topic')) return 'related_topics';
  if (f.includes('quer') || h.startsWith('query')) return 'related_queries';
  return 'unknown';
}

/** Classic exports carry a preamble ("Category: ..."), so the header is the first row with 2+ fields. */
function toTable(text: string): { header: string[]; rows: Record<string, string>[] } {
  const all = parseCsv(text);
  const start = all.findIndex((r) => r.length >= 2);
  if (start < 0) return { header: [], rows: [] };
  const header = (all[start] ?? []).map((h) => h.trim());
  const rows = all.slice(start + 1)
    .filter((r) => r.length >= 2)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { header, rows };
}

async function detectBlock(page: Page): Promise<RunStatus | null> {
  if (page.url().includes('accounts.google.com')) return 'SIGN_IN_REQUIRED';
  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (body.includes('sign in to try the new explore')) return 'SIGN_IN_REQUIRED';
  if (body.includes('too many requests') || body.includes('unusual traffic') || /\b429\b/.test(body)) return 'THROTTLED';
  return null;
}

async function scrollAll(page: Page): Promise<void> {
  for (let i = 0; i < 9; i++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
}

export interface TrendsRunOptions {
  q: string; geo?: string; date?: string; headless?: boolean; quiet?: boolean;
  /** Share one open Chrome profile across several runs (parallel tabs). The caller closes it. */
  context?: BrowserContext;
  /** Download only the related-queries CSVs (top and rising). Faster, and skips the series and region downloads that fail most often. */
  queriesOnly?: boolean;
}
export interface TrendsRunResult {
  status: RunStatus; keyword: string; geo: string; date: string; startedAt: string; note: string; runDir: string; sections: SavedFile[];
}

/** One Explore page for one keyword and country: downloads and parses every CSV on it. Never throws on a blocked page. */
export async function fetchTrendsRun(opts: TrendsRunOptions): Promise<TrendsRunResult> {
  const q = opts.q;
  const geo = opts.geo ?? '';
  const date = opts.date ?? 'today 12-m';
  const headless = opts.headless ?? false;

  const startedAt = new Date().toISOString();
  const slug = `${q.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\W+/g, '-').toLowerCase()}_${geo || 'WW'}`;
  const runDir = path.join(OUT_ROOT, `${slug}_${startedAt.replace(/[:.]/g, '-')}`);
  mkdirSync(runDir, { recursive: true });

  const url = `https://trends.google.com/explore?q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}${geo ? `&geo=${geo}` : ''}`;
  const ownContext = !opts.context;
  const ctx = opts.context ?? await openTrendsContext(headless);
  // A shared context runs several pages side by side (one tab each); an owned context reuses its first tab.
  const page = ownContext ? (ctx.pages()[0] ?? (await ctx.newPage())) : await ctx.newPage();
  let status: RunStatus = 'ERROR';
  let note = '';
  let httpStatus: number | null = null;
  const saved: SavedFile[] = [];
  const failedClicks: string[] = [];

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    httpStatus = resp?.status() ?? null;
    await page.waitForTimeout(4500);
    await scrollAll(page);

    const blocked = httpStatus === 429 ? 'THROTTLED' : await detectBlock(page);
    if (blocked) {
      status = blocked;
      note = `Page blocked (${blocked}) at ${page.url()}`;
    } else {
      // Cookie bar can sit on top of the lowest download icons.
      await page.getByRole('button', { name: /^got it$/i }).click({ timeout: 2000 }).catch(() => undefined);

      // Sections lazy-load as they scroll into view, so walk down the page and click each
      // newly visible download icon once. Menu items whose name merely contains "download"
      // (e.g. category "Music Streams & Downloads") are not buttons with that label prefix.
      const candidates = page.locator(
        'button:is([aria-label*="download" i],[aria-label*="export" i],[title*="download" i]),'
        + ' [role="button"]:is([aria-label*="download" i],[aria-label*="export" i])',
      );
      let seen = 0;
      const clickedLabels = new Set<string>();
      const attempts = new Map<string, number>();
      // Related-queries panels render empty ("0–0 of 0") until their data arrives. Scroll to the
      // bottom and wait for at least one panel to leave that state before collecting.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForFunction(
        () => !/0\s*[–-]\s*0\s+of\s+0/.test(document.body.innerText),
        undefined,
        { timeout: 25_000 },
      ).catch(() => { note = 'related queries panels stayed empty (0-0 of 0)'; });
      await page.evaluate(() => window.scrollTo(0, 0));
      for (let step = 0; step < 30; step++) {
        const n = await candidates.count();
        for (let i = 0; i < n; i++) {
          const btn = candidates.nth(i);
          if (!(await btn.isVisible().catch(() => false))) continue;
          const label = (await btn.getAttribute('aria-label').catch(() => null)) ?? (await btn.getAttribute('title').catch(() => null)) ?? 'download';
          if (/category/i.test(label) || (opts.queriesOnly && !/quer/i.test(label)) || clickedLabels.has(label) || (attempts.get(label) ?? 0) >= 3) continue;
          attempts.set(label, (attempts.get(label) ?? 0) + 1);
          await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => undefined);
          await page.waitForTimeout(500);
          seen++;
          try {
            const [download] = await Promise.all([
              page.waitForEvent('download', { timeout: 15_000 }),
              // The sticky filter bar can cover an icon after auto-scroll; force the click.
              btn.click({ timeout: 8000, force: true }),
            ]);
            const name = `${String(saved.length + 1).padStart(2, '0')}_${download.suggestedFilename()}`;
            const target = path.join(runDir, name);
            await download.saveAs(target);
            const { header, rows } = toTable(readFileSync(target, 'utf8'));
            if (rows.length === 0) {
              // Header-only CSV: the chart had not loaded yet. Not a result, so retry after a pause.
              await page.waitForTimeout(5000);
              throw new Error(`EMPTY_CSV (${download.suggestedFilename()} has a header but no data rows)`);
            }
            saved.push({ kind: classify(download.suggestedFilename(), header), file: name, header, rows });
            clickedLabels.add(label); // by label: DOM markers are lost when the page re-renders
            await page.waitForTimeout(600 + Math.random() * 800);
          } catch (e) {
            failedClicks.push(`${label}: ${(e as Error).message.split('\n')[0]}`);
          }
          break; // re-query: the page may re-render after a download
        }
        await page.mouse.move(700, 600);
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(900);
      }
      await page.screenshot({ path: path.join(runDir, 'page-bottom.png') }).catch(() => undefined);
      note = `${seen} download buttons clicked${note ? `; ${note}` : ''}`;
      const kinds = new Set(saved.map((s) => s.kind));
      const hasRelated = kinds.has('top_queries') || kinds.has('rising_queries') || kinds.has('related_queries');
      status = saved.length === 0 ? 'NO_DOWNLOADS' : kinds.has('interest_over_time') && hasRelated ? 'OK' : 'PARTIAL';
    }
  } catch (e) {
    status = 'ERROR';
    note = (e as Error).message.split('\n')[0] ?? '';
  } finally {
    await page.screenshot({ path: path.join(runDir, 'page.png'), fullPage: true }).catch(() => undefined);
    if (ownContext) await ctx.close().catch(() => undefined);
    else await page.close().catch(() => undefined);
  }

  const result = {
    schema: 'trends-browser-run/1',
    keyword: q, geo: geo || 'WORLDWIDE', date, url, startedAt, finishedAt: new Date().toISOString(),
    status, httpStatus, note, failedClicks,
    sections: saved.map((s) => ({ kind: s.kind, file: s.file, rowCount: s.rows.length, header: s.header, rows: s.rows })),
  };
  writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  mkdirSync(OUT_ROOT, { recursive: true });
  appendFileSync(path.join(OUT_ROOT, 'log.jsonl'), `${JSON.stringify({
    startedAt, keyword: q, geo: result.geo, date, status, httpStatus, note,
    sections: saved.map((s) => `${s.kind}:${s.rows.length}`), failedClicks: failedClicks.length, runDir,
  })}\n`);

  if (!opts.quiet) {
    console.log(`Status: ${status}${note ? ` (${note})` : ''}`);
    for (const s of saved) {
      console.log(`  ${s.kind.padEnd(19)} ${String(s.rows.length).padStart(3)} rows  ${s.file}`);
      for (const r of s.rows.slice(0, 5)) console.log(`      ${Object.values(r).join(' | ')}`);
    }
    if (failedClicks.length) console.log(`  ${failedClicks.length} buttons gave no download (see result.json)`);
    console.log(`Saved: ${runDir}`);
  }
  return { status, keyword: q, geo: result.geo, date, startedAt, note, runDir, sections: saved };
}

async function fetchTrendsCli(): Promise<void> {
  const q = arg('q');
  if (!q) throw new Error('Pass --q "<keyword>" [--geo BR] [--date "today 12-m"] [--headless]');
  await fetchTrendsRun({ q, geo: arg('geo', '')!, date: arg('date', 'today 12-m')!, headless: process.argv.includes('--headless') });
}

/** Run as a CLI only when this file is the entry point, so other modules can import fetchTrendsRun. */
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  const cmd = process.argv[2];
  (cmd === 'login' ? login() : cmd === 'fetch' ? fetchTrendsCli() : Promise.reject(new Error('Use: login | fetch')))
    .catch((e: unknown) => { console.error(`trends: ${(e as Error).message}`); process.exitCode = 1; });
}
