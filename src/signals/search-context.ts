/**
 * Search-demand context for one report: what Google Trends says people search around the market.
 *
 * Pure logic plus a small on-disk cache. No browser here, so the blog and image generators can import it
 * safely: they only READ the cache (readSearchContext) and never wait on Google. The collection step
 * (context-collector.ts) fills the cache ahead of time.
 *
 * Rules carried from the project:
 *  - A failed collection is UNKNOWN, never zero (status is stored, nothing is invented).
 *  - Trends is search INTEREST only. The prompt block says so and forbids using it as a market figure.
 *  - No em dashes in anything that can reach a prompt.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CONTEXT_DIR = path.resolve('.cache/signals/context');

/** ISO 3166 codes Google Trends accepts for the countries Ken Research covers. */
export const GEO_CODES: Readonly<Record<string, string>> = {
  Argentina: 'AR', Australia: 'AU', Austria: 'AT', Bahrain: 'BH', Bangladesh: 'BD', Belgium: 'BE', Bolivia: 'BO', Brazil: 'BR',
  Bulgaria: 'BG', Cambodia: 'KH', Cameroon: 'CM', Canada: 'CA', Chile: 'CL', China: 'CN', Colombia: 'CO', 'Costa Rica': 'CR',
  Croatia: 'HR', 'Czech Republic': 'CZ', Denmark: 'DK', 'Dominican Republic': 'DO', Ecuador: 'EC', Egypt: 'EG', Ethiopia: 'ET',
  Finland: 'FI', France: 'FR', Germany: 'DE', Ghana: 'GH', Greece: 'GR', Guatemala: 'GT', 'Hong Kong': 'HK', Hungary: 'HU',
  India: 'IN', Indonesia: 'ID', Iraq: 'IQ', Ireland: 'IE', Israel: 'IL', Italy: 'IT', Japan: 'JP', Jordan: 'JO', Kazakhstan: 'KZ',
  Kenya: 'KE', Kuwait: 'KW', Malaysia: 'MY', Mexico: 'MX', Morocco: 'MA', Myanmar: 'MM', Nepal: 'NP', Netherlands: 'NL',
  'New Zealand': 'NZ', Nigeria: 'NG', Norway: 'NO', Oman: 'OM', Pakistan: 'PK', Panama: 'PA', Paraguay: 'PY', Peru: 'PE',
  Philippines: 'PH', Poland: 'PL', Portugal: 'PT', Qatar: 'QA', Romania: 'RO', Russia: 'RU', Rwanda: 'RW', 'Saudi Arabia': 'SA',
  Senegal: 'SN', Serbia: 'RS', Singapore: 'SG', Slovakia: 'SK', 'South Africa': 'ZA', 'South Korea': 'KR', Spain: 'ES',
  'Sri Lanka': 'LK', Sweden: 'SE', Switzerland: 'CH', Taiwan: 'TW', Tanzania: 'TZ', Thailand: 'TH', Tunisia: 'TN', Turkey: 'TR',
  Uganda: 'UG', Ukraine: 'UA', 'United Arab Emirates': 'AE', UAE: 'AE', 'United Kingdom': 'GB', UK: 'GB', 'United States': 'US',
  USA: 'US', Uruguay: 'UY', Venezuela: 'VE', Vietnam: 'VN', Zimbabwe: 'ZW',
};

export interface DerivedKeywords {
  country: string | null;
  geo: string | null;
  /** The market phrase without country and trailing report words, e.g. "Smart Cold Chain for Meat Export". */
  head: string;
  /** Broad to narrow fallbacks, longest first, e.g. head, last 3 words, last 2 words, last word. */
  ladder: string[];
}

const REPORT_TAIL = /\b(market|industry|outlook|size|share|growth|forecast|report|analysis|trends?)\b.*$/i;

/**
 * Sheet rows with an empty Title use the report URL as the title. The market name is in the URL slug, so
 * ".../industry-reports/united-states-short-term-vacation-rental-market" becomes
 * "United States Short Term Vacation Rental Market". Real titles pass through unchanged.
 */
export function canonicalTitle(title: string): string {
  const t = title.trim();
  if (!/^https?:\/\//i.test(t)) return t;
  const slug = t.split(/[?#]/)[0]!.replace(/\/+$/, '').split('/').pop() ?? '';
  const words = decodeURIComponent(slug).replace(/\.[a-z0-9]{2,5}$/i, '').split(/[-_]+/).filter(Boolean);
  return words.length ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : t;
}

/** "Kenya Lubricants Market Outlook to 2030" -> country Kenya (KE), head "Lubricants". */
export function deriveKeywords(title: string): DerivedKeywords {
  let text = canonicalTitle(title).replace(/\s+/g, ' ').trim();
  // Longest names first so "South Africa" wins over "Africa" and "United Arab Emirates" over "Arab".
  const names = Object.keys(GEO_CODES).sort((a, b) => b.length - a.length);
  let country: string | null = null;
  for (const n of names) {
    const re = new RegExp(`\\b${n.replace(/\s/g, '\\s+')}\\b`, 'i');
    if (re.test(text)) { country = n; text = text.replace(re, ' '); break; }
  }
  text = text.replace(/\b(apac|asia[- ]pacific|global|worldwide|middle east|mena|gcc|europe|africa|latin america)\b/gi, ' ');
  const head = text.replace(REPORT_TAIL, ' ').replace(/[^\p{L}\p{N}\s&-]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const words = head.split(' ').filter(Boolean);
  const ladder = [...new Set([head, words.slice(-3).join(' '), words.slice(-2).join(' '), words.slice(-1).join(' ')])].filter((w) => w.length >= 3);
  const canonical = country && (country === 'UAE' ? 'United Arab Emirates' : country === 'UK' ? 'United Kingdom' : country === 'USA' ? 'United States' : country);
  return { country: canonical ?? null, geo: country ? (GEO_CODES[country] ?? null) : null, head, ladder };
}

export interface TrendShape {
  label: 'rising' | 'falling' | 'stable' | 'unknown';
  changePct: number | null;
  peakMonth: string | null;
  points: number;
  droppedIncompleteWeek: boolean;
}

/** Rows are {Time, <keyword>} weekly points. The newest week is dropped when it is not finished. */
export function summariseSeries(rows: Array<Record<string, string>>, now: Date = new Date()): TrendShape {
  const pts = rows
    .map((r) => { const v = Object.values(r); return { date: new Date(`${v[0] ?? ''}T00:00:00Z`), value: Number.parseInt((v[1] ?? '').replace('<', ''), 10) }; })
    .filter((p) => !Number.isNaN(p.date.getTime()) && Number.isFinite(p.value));
  if (pts.length < 6) return { label: 'unknown', changePct: null, peakMonth: null, points: pts.length, droppedIncompleteWeek: false };
  let dropped = false;
  const last = pts[pts.length - 1]!;
  if (now.getTime() - last.date.getTime() < 7 * 86_400_000) { pts.pop(); dropped = true; }
  const third = Math.max(2, Math.floor(pts.length / 3));
  const avg = (a: typeof pts): number => a.reduce((s, p) => s + p.value, 0) / a.length;
  const first = avg(pts.slice(0, third));
  const recent = avg(pts.slice(-third));
  const changePct = first > 0 ? Math.round(((recent - first) / first) * 100) : null;
  const peak = pts.reduce((m, p) => (p.value > m.value ? p : m), pts[0]!);
  const peakMonth = peak.date.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const label = changePct === null ? 'unknown' : changePct >= 10 ? 'rising' : changePct <= -10 ? 'falling' : 'stable';
  return { label, changePct, peakMonth, points: pts.length, droppedIncompleteWeek: dropped };
}

export interface QueryItem { query: string; interest: number | null; change: string | null }
export interface DroppedQuery { query: string; reason: string }

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Terms that must never reach a prompt, whatever the market is. Everything else is left to the model to judge. */
const NEVER_USE = /\b(sex\w*|porn\w*|intim\w*|erotic\w*|adult|condom\w*|vagin\w*|anal|durex|kamasutra|personal lubricants?|lube for (?:him|her|sex))\b/;

/** Drops adult terms and near-duplicates (accent or case variants). Every drop is returned with its reason. */
export function cleanQueries(raw: QueryItem[], limit = 10): { kept: QueryItem[]; dropped: DroppedQuery[] } {
  const kept: QueryItem[] = [];
  const dropped: DroppedQuery[] = [];
  const seen = new Set<string>();
  for (const q of raw) {
    const key = norm(q.query);
    if (!key) continue;
    if (NEVER_USE.test(key)) { dropped.push({ query: q.query, reason: 'adult or unsafe term' }); continue; }
    if (seen.has(key)) { dropped.push({ query: q.query, reason: 'duplicate of an accent or case variant' }); continue; }
    seen.add(key);
    if (kept.length < limit) kept.push(q); // beyond the cap is "not selected", not a cleaning decision, so it is not logged as dropped
  }
  return { kept, dropped };
}

export function toQueryItems(rows: Array<Record<string, string>>): QueryItem[] {
  return rows.map((r) => {
    const v = Object.values(r);
    const interest = Number.parseInt((v[1] ?? '').replace(/[^\d]/g, ''), 10);
    return { query: (v[0] ?? '').trim(), interest: Number.isFinite(interest) ? interest : null, change: (v[2] ?? '').trim() || null };
  }).filter((q) => q.query);
}

export type EntryStatus = 'OK' | 'PARTIAL' | 'DATA_UNAVAILABLE';

export interface ContextEntry {
  scope: string; // "Worldwide" or a country name
  geo: string | null;
  keyword: string;
  triedKeywords: string[];
  status: EntryStatus;
  statusNote: string;
  trend: TrendShape | null;
  top: QueryItem[];
  rising: QueryItem[];
  regions: Array<{ region: string; interest: number | null }>;
  dropped: DroppedQuery[];
  runDir: string | null;
}

export interface SearchContext {
  schema: 'search-context/1';
  title: string;
  url: string | null;
  collectedAt: string;
  period: string;
  source: 'google-trends-browser' | 'google-trends-api';
  entries: ContextEntry[];
}

export function slugFor(title: string): string {
  return norm(canonicalTitle(title)).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'untitled';
}

export function contextPath(title: string): string {
  return path.join(CONTEXT_DIR, `${slugFor(title)}.json`);
}

export function saveSearchContext(ctx: SearchContext): string {
  mkdirSync(CONTEXT_DIR, { recursive: true });
  const file = contextPath(ctx.title);
  writeFileSync(file, JSON.stringify(ctx, null, 2));
  return file;
}

/** Cached context for a title, or null when none exists or it is older than maxAgeDays. Never throws. */
export function readSearchContext(title: string, maxAgeDays = 30, now: Date = new Date()): SearchContext | null {
  try {
    const file = contextPath(title);
    if (!existsSync(file)) return null;
    const ctx = JSON.parse(readFileSync(file, 'utf8')) as SearchContext;
    if (ctx.schema !== 'search-context/1') return null;
    if (now.getTime() - new Date(ctx.collectedAt).getTime() > maxAgeDays * 86_400_000) return null;
    return ctx;
  } catch {
    return null;
  }
}

const noDash = (s: string): string => s.replace(/\s*[—―]\s*/g, ', ');
const fmtQ = (q: QueryItem): string => `${q.query}${q.interest !== null ? ` (${q.interest}${q.change ? `, ${q.change.toLowerCase() === 'breakout' ? 'breakout' : (q.change.startsWith('-') || q.change.startsWith('+') ? q.change : `+${q.change}`)}` : ''})` : ''}`;

function trendLine(t: TrendShape | null): string {
  if (!t || t.label === 'unknown') return 'trend shape unavailable';
  const pct = t.changePct === null ? '' : `, ${t.changePct > 0 ? '+' : ''}${t.changePct}% from the start to the end of the year`;
  return `search interest is ${t.label}${pct}${t.peakMonth ? `, peak in ${t.peakMonth}` : ''}`;
}

export type BlockMode = 'blog' | 'image';

/** The text injected into a prompt. Returns '' when there is nothing usable, so callers can append it blindly. */
export function renderSearchContextBlock(ctx: SearchContext | null, mode: BlockMode): string {
  if (!ctx) return '';
  const usable = ctx.entries.filter((e) => e.status !== 'DATA_UNAVAILABLE' && (e.top.length || e.rising.length || e.trend));
  if (!usable.length) return '';
  const cap = mode === 'image' ? 5 : 10;
  const lines: string[] = [];
  lines.push(`SEARCH DEMAND CONTEXT (Google Trends, collected ${ctx.collectedAt.slice(0, 10)}, ${ctx.period})`);
  if (mode === 'blog') {
    lines.push('This is our own search-demand POC (proof of concept) for the keyword and market in the inputs above: real Google Trends data collected for it. Use it, together with the report page, to build the article: choose the angle, natural keywords, headings, FAQ questions and the closing question from it. It measures search interest only, so never present it as market size, share or growth; every figure in the article must come from the Ken Research report page and verified sources. Skip any query that is not about this market. Rising queries with a small base are early signals, not proof of a trend.');
  } else {
    lines.push('Use these only to decide which trend, segment or demand shift the image should highlight. Do not print the search terms or Trends percentages as statistics in the image; every statistic in the image still comes from verified sources.');
  }
  for (const e of usable) {
    lines.push('');
    lines.push(`[${e.scope}] "${e.keyword}"${e.trend && e.trend.label !== 'unknown' ? `: ${trendLine(e.trend)}` : ''}`);
    if (e.top.length) lines.push(`Top queries: ${e.top.slice(0, cap).map(fmtQ).join('; ')}`);
    // A query already listed under Top is not repeated under Rising.
    const topKeys = new Set(e.top.map((q) => norm(q.query)));
    const risingOnly = e.rising.filter((q) => !topKeys.has(norm(q.query)));
    if (risingOnly.length) lines.push(`Rising queries: ${risingOnly.slice(0, cap).map(fmtQ).join('; ')}`);
    if (mode === 'blog' && e.regions.length) lines.push(`Top regions by search share: ${e.regions.slice(0, 5).map((r) => r.region).join(', ')}`);
  }
  if (mode === 'blog') {
    lines.push('');
    lines.push('Now run your own search-demand POC for the same keyword and market: research how people search for it (Google autosuggest, People Also Ask, related questions, recent news and what buyers ask) and combine your findings with our POC above. If they disagree, follow the better-evidenced one.');
  }
  return noDash(lines.join('\n'));
}

/**
 * Plain text for the sheet's "Trends Data" column: what was collected for the row, readable at a glance and
 * including what was removed and why. No prompt instructions; the cell is a record, not a prompt.
 */
export function renderSearchContextSheetText(ctx: SearchContext): string {
  const lines: string[] = [`Google Trends, collected ${ctx.collectedAt.slice(0, 10)}, ${ctx.period}`];
  for (const e of ctx.entries) {
    lines.push('');
    lines.push(`[${e.scope}] "${e.keyword}"${e.triedKeywords.length > 1 ? ` (tried: ${e.triedKeywords.join(', ')})` : ''} - ${e.status}`);
    if (e.status === 'DATA_UNAVAILABLE') { lines.push(`No data: ${e.statusNote || 'no run returned data'}`); continue; }
    if (e.trend && e.trend.label !== 'unknown') lines.push(`Trend: ${trendLine(e.trend)}`);
    lines.push(e.top.length ? `Top queries: ${e.top.map(fmtQ).join('; ')}` : 'Top queries: none returned');
    const topKeys = new Set(e.top.map((q) => norm(q.query)));
    const risingOnly = e.rising.filter((q) => !topKeys.has(norm(q.query)));
    lines.push(risingOnly.length ? `Rising queries: ${risingOnly.map(fmtQ).join('; ')}` : 'Rising queries: none beyond the top list');
    if (e.dropped.length) lines.push(`Removed: ${e.dropped.map((d) => `${d.query} (${d.reason})`).join('; ')}`);
  }
  return noDash(lines.join('\n')).slice(0, 45_000);
}

/** True when a fresh cached context exists that would produce a non-empty prompt block. Does not write the usage log. */
export function hasUsableSearchContext(title: string): boolean {
  return renderSearchContextBlock(readSearchContext(title), 'blog').length > 0;
}

/**
 * Convenience for generators: the block for a title, or '' when no fresh context is cached.
 * Every call records what was (or was not) sent to GPT in .cache/signals/context/usage.jsonl, so a generated
 * blog or image can later be matched to the exact search data it was given.
 */
export function searchContextBlock(title: string, mode: BlockMode): string {
  const ctx = readSearchContext(title);
  const block = renderSearchContextBlock(ctx, mode);
  try {
    mkdirSync(CONTEXT_DIR, { recursive: true });
    appendFileSync(path.join(CONTEXT_DIR, 'usage.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(), title, mode, sent: block.length > 0, contextCollectedAt: ctx?.collectedAt ?? null,
      sections: ctx ? ctx.entries.map((e) => ({ scope: e.scope, keyword: e.keyword, top: e.top.map((q) => q.query), rising: e.rising.map((q) => q.query) })) : [],
    })}\n`);
  } catch { /* logging must never break generation */ }
  return block;
}

/**
 * Puts the block right after the "Primary Report URL:" input line, so it reads as part of the inputs in every
 * prompt file. If a prompt has no such line the block is appended, never dropped.
 */
export function insertSearchContext(prompt: string, block: string): string {
  const line = /^(Primary Report URL:[^\n]*)$/m;
  return line.test(prompt) ? prompt.replace(line, (m) => `${m}\n\n${block}`) : `${prompt}\n\n${block}\n`;
}
