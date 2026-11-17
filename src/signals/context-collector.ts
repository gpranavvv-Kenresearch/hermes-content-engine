/**
 * Fills the search-context cache for a report title by driving the Google Trends browser fetcher.
 *
 * Per title: a Worldwide pass and, when the title names a country, a country pass. The passes run side by side in
 * one Chrome (one tab each). A pass that returns only some sections is retried and the sections are MERGED across
 * attempts (one try may bring the series, the next the related queries). After two attempts on a keyword the pass moves
 * down the keyword ladder (full market phrase, then shorter and broader terms). Everything is appended to
 * .cache/signals/context/log.jsonl.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import {
  CONTEXT_DIR, cleanQueries, deriveKeywords, readSearchContext, renderSearchContextSheetText, saveSearchContext, summariseSeries, toQueryItems,
  type ContextEntry, type SearchContext,
} from './search-context.js';
import { fetchTrendsRun, openTrendsContext, type TrendsRunResult } from './trends-browser.js';

export interface CollectOptions {
  url?: string | null;
  force?: boolean;
  headless?: boolean;
  /** Pause between retry waves so Google does not throttle the account. Passes inside a wave run together. */
  gapMs?: number;
  maxAttemptsPerScope?: number;
  /** Re-collect only when the cached context is older than this. */
  freshDays?: number;
  log?: (line: string) => void;
  /** Test seam. */
  fetchRun?: typeof fetchTrendsRun;
}

export interface CollectOutcome {
  title: string;
  status: 'COLLECTED' | 'CACHED' | 'FAILED';
  note: string;
  file: string | null;
  context: SearchContext | null;
}

type Rows = Array<Record<string, string>>;
type Merged = Partial<Record<string, Rows>>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const has = (m: Merged, kind: string): boolean => (m[kind]?.length ?? 0) > 0;
/** The blog needs the related queries only: a pass is complete once top or rising queries are in hand. */
const complete = (m: Merged): boolean => has(m, 'top_queries') || has(m, 'rising_queries');
const score = (m: Merged): number => Object.values(m).filter((r) => (r?.length ?? 0) > 0).length;

interface ScopeState {
  scope: string;
  geo: string;
  idx: number; // position on the keyword ladder
  attempts: number; // attempts on the current keyword
  merged: Merged; // sections gathered for the current keyword
  runDir: string | null;
  tried: string[];
  done: boolean;
  chosen: { keyword: string; merged: Merged; runDir: string | null } | null; // best result so far
  note: string;
}

function logLine(entry: Record<string, unknown>): void {
  mkdirSync(CONTEXT_DIR, { recursive: true });
  appendFileSync(path.join(CONTEXT_DIR, 'log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/**
 * Used by the blog pipelines BEFORE a prompt is built: collect the Trends search context for the row, so the
 * prompt reads it from the cache. Best effort by design: any failure (expired Google sign-in, throttling, no data,
 * a crash) is logged and the row is generated with the current prompt, never blocked.
 * On by default; BLOG_SEARCH_CONTEXT=0 turns it off.
 */
export async function collectSearchContextSafely(title: string, url: string | null, log: (line: string) => void): Promise<{ status: string; sheetText: string }> {
  if (process.env.BLOG_SEARCH_CONTEXT === '0') return { status: 'DISABLED', sheetText: '' };
  const today = new Date().toISOString().slice(0, 10);
  try {
    log(`[search-context] collecting Google Trends for "${title}"`);
    const out = await collectSearchContext(title, { url, log: (l) => log(`[search-context]${l}`) });
    log(`[search-context] ${out.status}${out.note ? ` (${out.note})` : ''}`);
    // The sheet text always says what happened, so an empty column is never ambiguous.
    const sheetText = out.context
      ? renderSearchContextSheetText(out.context)
      : `NOT AVAILABLE on ${today}: ${out.note || 'no Trends data'}. The blog was generated with the current prompt, without Google Trends.`;
    return { status: out.status, sheetText };
  } catch (e) {
    log(`[search-context] skipped, generating without it: ${(e as Error).message}`);
    return { status: 'ERROR', sheetText: `NOT AVAILABLE on ${today}: ${(e as Error).message}. The blog was generated with the current prompt, without Google Trends.` };
  }
}

export async function collectSearchContext(title: string, opts: CollectOptions = {}): Promise<CollectOutcome> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const gap = opts.gapMs ?? 6_000;
  const maxKeywords = opts.maxAttemptsPerScope ?? 3;

  if (!opts.force) {
    const cached = readSearchContext(title, opts.freshDays ?? 7);
    // A cache with no complete entry (every pass came back partial) is only trusted for a day, not a week, so a flaky
    // run is retried soon instead of locking in thin data.
    const trusted = cached && (cached.entries.some((e) => e.status === 'OK') || Date.now() - new Date(cached.collectedAt).getTime() < 86_400_000);
    if (cached && trusted) { log(`  cached (collected ${cached.collectedAt.slice(0, 10)}), skipping. Use --force to refresh.`); return { title, status: 'CACHED', note: 'fresh cache', file: null, context: cached }; }
  }

  const kw = deriveKeywords(title);
  const ladder = kw.ladder.slice(0, maxKeywords);
  log(`  keywords: head "${kw.head}", country ${kw.country ?? 'none (Worldwide only)'}${kw.geo ? ` (${kw.geo})` : ''}, ladder ${JSON.stringify(ladder)}`);

  const scopes: ScopeState[] = [{ scope: 'Worldwide', geo: '' }, ...(kw.country && kw.geo ? [{ scope: kw.country, geo: kw.geo }] : [])]
    .map((s) => ({ ...s, idx: 0, attempts: 0, merged: {}, runDir: null, tried: [], done: false, chosen: null, note: '' }));

  // One Chrome for the whole title. A test seam run needs no browser.
  const browser: BrowserContext | null = opts.fetchRun ? null : await openTrendsContext(opts.headless ?? false);
  const run = opts.fetchRun ?? fetchTrendsRun;
  let aborted: string | null = null;

  try {
    const maxWaves = maxKeywords * 2;
    for (let wave = 1; wave <= maxWaves && !aborted; wave++) {
      const active = scopes.filter((s) => !s.done);
      if (active.length === 0) break;
      if (wave > 1) await sleep(gap);
      log(`  wave ${wave}: ${active.map((s) => `[${s.scope}] "${ladder[s.idx]}"`).join(' + ')} (side by side)`);

      const results = await Promise.all(active.map(async (s): Promise<[ScopeState, TrendsRunResult]> => {
        const keyword = ladder[s.idx]!;
        if (!s.tried.includes(keyword)) s.tried.push(keyword);
        return [s, await run({ q: keyword, geo: s.geo, headless: opts.headless ?? false, quiet: true, queriesOnly: true, ...(browser ? { context: browser } : {}) })];
      }));

      for (const [s, res] of results) {
        const kind = (r: TrendsRunResult): string => r.sections.map((x) => `${x.kind}:${x.rows.length}`).join(', ') || 'no sections';
        log(`      [${s.scope}] ${res.status}: ${kind(res)}`);
        if (res.status === 'SIGN_IN_REQUIRED' || res.status === 'THROTTLED') { aborted = res.status; s.note = res.status; continue; }
        for (const sec of res.sections) if (sec.rows.length > 0 && !has(s.merged, sec.kind)) s.merged[sec.kind] = sec.rows;
        s.runDir = res.runDir;
        s.note = res.note;
        const keyword = ladder[s.idx]!;
        if (s.chosen === null || score(s.merged) > score(s.chosen.merged) || s.chosen.keyword === keyword) s.chosen = { keyword, merged: { ...s.merged }, runDir: s.runDir };
        if (complete(s.merged)) { s.done = true; continue; }
        s.attempts++;
        if (s.attempts >= 2) { // give up on this keyword: try a broader one, keeping the best result seen
          if (s.chosen === null || score(s.merged) > score(s.chosen.merged)) s.chosen = { keyword, merged: { ...s.merged }, runDir: s.runDir };
          s.idx++; s.attempts = 0; s.merged = {};
          if (s.idx >= ladder.length) s.done = true;
        }
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }

  const entries: ContextEntry[] = scopes.map((s) => {
    const c = s.chosen;
    if (!c || score(c.merged) === 0) {
      return { scope: s.scope, geo: s.geo || null, keyword: s.tried[0] ?? kw.head, triedKeywords: s.tried, status: 'DATA_UNAVAILABLE', statusNote: s.note || 'no run returned data', trend: null, top: [], rising: [], regions: [], dropped: [], runDir: s.runDir } as ContextEntry;
    }
    const top = cleanQueries(toQueryItems(c.merged['top_queries'] ?? []));
    const rising = cleanQueries(toQueryItems(c.merged['rising_queries'] ?? []));
    const series = c.merged['interest_over_time'] ?? [];
    return {
      scope: s.scope, geo: s.geo || null, keyword: c.keyword, triedKeywords: s.tried,
      status: complete(c.merged) ? 'OK' : 'PARTIAL', statusNote: s.note,
      trend: series.length ? summariseSeries(series) : null,
      top: top.kept, rising: rising.kept,
      regions: (c.merged['interest_by_region'] ?? []).slice(0, 8).map((r) => { const v = Object.values(r); const n = Number.parseInt(v[1] ?? '', 10); return { region: (v[0] ?? '').trim(), interest: Number.isFinite(n) ? n : null }; }),
      dropped: [...top.dropped, ...rising.dropped],
      runDir: c.runDir,
    };
  });

  const usable = entries.some((e) => e.status !== 'DATA_UNAVAILABLE');
  if (!usable) {
    const note = aborted === 'SIGN_IN_REQUIRED' ? 'Google session expired: run npm run trends:login' : aborted === 'THROTTLED' ? 'Google throttled the account, retry later' : 'no Trends data for this title';
    logLine({ title, status: 'FAILED', note, tried: entries.map((e) => e.triedKeywords) });
    log(`  FAILED: ${note}`);
    return { title, status: 'FAILED', note, file: null, context: null };
  }

  const ctx: SearchContext = {
    schema: 'search-context/1', title, url: opts.url ?? null, collectedAt: new Date().toISOString(),
    period: 'past 12 months', source: 'google-trends-browser', entries,
  };
  const file = saveSearchContext(ctx);
  logLine({ title, status: 'COLLECTED', file, entries: entries.map((e) => ({ scope: e.scope, keyword: e.keyword, status: e.status, tried: e.triedKeywords, top: e.top.length, rising: e.rising.length, dropped: e.dropped })) });
  log(`  saved ${file}`);
  return { title, status: 'COLLECTED', note: aborted ?? '', file, context: ctx };
}
